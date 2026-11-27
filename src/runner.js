// The runner. Drives k trials per scenario against one target, judges each
// trial with the predicates and aggregates pass^k and attack success rate.

import { createSandbox } from './sandbox.js';
import { judge } from './predicates.js';
import { attackerIndicators, trifecta } from './scenario.js';
import { trialSeed } from './rng.js';
import { truncate } from './text.js';

export const DEFAULT_LIMITS = { maxSteps: 10, maxToolCalls: 30, trialTimeoutMs: 600000, repeatLimit: 3, invalidLimit: 3 };

class TrialAbort extends Error {}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TrialAbort(`${label} exceeded ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Run one trial. Never throws; errors end up in the trial record. */
export async function runTrial({ scenario, target, trial, seed, systemPrompt = null, allowTools = null, limits = {} }) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const sandbox = createSandbox(scenario, { seed, allowTools });
  const finals = [];
  let error = null;
  let session = null;
  const started = Date.now();
  const deadline = started + L.trialTimeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  try {
    session = await withTimeout(
      target.open({ scenarioId: scenario.id, trial, seed, tools: sandbox.tools, context: scenario.task.context || null, system: systemPrompt }),
      remaining(),
      'starting the target',
    );
    let totalCalls = 0;
    for (let t = 0; t < sandbox.turns.length; t++) {
      sandbox.setTurn(t);
      sandbox.record({ type: 'user', content: sandbox.turns[t] });
      let reply = await withTimeout(session.user(sandbox.turns[t]), remaining(), 'the trial');
      let steps = 0;
      let lastKey = null;
      let repeats = 0;
      let invalidRun = 0;
      while (reply.type === 'tool_call') {
        steps += 1;
        totalCalls += 1;
        if (steps > L.maxSteps) throw new TrialAbort(`step limit of ${L.maxSteps} tool calls in one turn reached`);
        if (totalCalls > L.maxToolCalls) throw new TrialAbort(`limit of ${L.maxToolCalls} tool calls per trial reached`);
        const key = `${reply.name}:${JSON.stringify(reply.arguments)}`;
        repeats = key === lastKey ? repeats + 1 : 1;
        lastKey = key;
        if (repeats > L.repeatLimit) throw new TrialAbort(`the same tool call repeated ${repeats} times in a row`);
        const result = sandbox.call(reply.name, reply.arguments);
        const last = sandbox.events[sandbox.events.length - 1];
        invalidRun = last.refused === 'invalid_arguments' ? invalidRun + 1 : 0;
        if (invalidRun >= L.invalidLimit) throw new TrialAbort(`${invalidRun} invalid tool calls in a row; failing closed`);
        reply = await withTimeout(
          session.toolResult({ id: reply.id, name: reply.name, content: result.content, isError: result.isError }),
          remaining(),
          'the trial',
        );
      }
      finals[t] = reply.content;
      sandbox.record({ type: 'final', content: reply.content });
    }
  } catch (e) {
    error = e?.message || String(e);
    sandbox.record({ type: 'error', message: error });
  } finally {
    if (session) {
      try {
        await session.close();
      } catch {
        // Closing a broken session must not hide the original error.
      }
    }
  }

  const ctx = {
    scenario,
    events: sandbox.events,
    finals,
    files: sandbox.files,
    initialFiles: sandbox.initialFiles,
    canary: sandbox.canary,
    indicators: attackerIndicators(scenario),
  };
  const verdict = judge(scenario, ctx, error);
  const refused = sandbox.events.filter((e) => e.type === 'tool_call' && (e.refused === 'not_allowed' || e.refused === 'not_offered'));
  return {
    trial,
    seed,
    status: verdict.status,
    passed: verdict.passed,
    hijacked: verdict.hijacked,
    utility: verdict.utility,
    hijacks: verdict.hijacks,
    success: verdict.success,
    blocked_calls: refused.map((e) => ({ tool: e.tool, args: e.args })),
    error,
    duration_ms: Date.now() - started,
    usage: session?.usage ? { ...session.usage } : {},
    events: sandbox.events.map((e) => compactEvent(e)),
  };
}

function compactEvent(e) {
  const out = { ...e };
  if (out.result) out.result = { content: truncate(out.result.content, 4000), isError: out.result.isError };
  if (typeof out.content === 'string') out.content = truncate(out.content, 8000);
  return out;
}

const ratio = (a, b) => (b ? a / b : 0);

/** Aggregate trial lists into the summary blocks of the report. */
export function aggregate(scenarioResults) {
  const block = () => ({ scenarios: 0, trials: 0, passed: 0, hijacked: 0, abandoned: 0, errors: 0, task_done: 0, scenarios_pass_hat_k: 0, blocked_calls: 0 });
  const overall = block();
  const categories = {};
  for (const s of scenarioResults) {
    const c = (categories[s.category] ||= block());
    for (const b of [overall, c]) {
      b.scenarios += 1;
      b.scenarios_pass_hat_k += s.pass_hat_k ? 1 : 0;
      for (const t of s.trials) {
        b.trials += 1;
        if (t.status === 'passed') b.passed += 1;
        if (t.status === 'hijacked') b.hijacked += 1;
        if (t.status === 'abandoned') b.abandoned += 1;
        if (t.status === 'error') b.errors += 1;
        if (t.utility) b.task_done += 1;
        b.blocked_calls += t.blocked_calls.length;
      }
    }
  }
  const finish = (b) => ({
    ...b,
    asr: ratio(b.hijacked, b.trials),
    utility: ratio(b.task_done, b.trials),
    pass_rate: ratio(b.passed, b.trials),
    pass_hat_k: ratio(b.scenarios_pass_hat_k, b.scenarios),
  });
  return {
    summary: finish(overall),
    categories: Object.fromEntries(Object.entries(categories).sort().map(([k, v]) => [k, finish(v)])),
  };
}

/**
 * Run a suite. options: scenarios, target, k, seed, systemPrompt,
 * allowTools, limits, concurrency, onTrial(scenario, trialResult).
 */
export async function runSuite({ scenarios, target, k = 1, seed = 1, systemPrompt = null, allowTools = null, limits = {}, concurrency = 1, onTrial }) {
  const jobs = [];
  for (const s of scenarios) for (let t = 0; t < k; t++) jobs.push({ s, t });
  const results = new Map(scenarios.map((s) => [s.id, []]));
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { s, t } = jobs[next++];
      const r = await runTrial({ scenario: s, target, trial: t, seed: trialSeed(seed, s.id, t), systemPrompt, allowTools, limits });
      results.get(s.id)[t] = r;
      if (onTrial) onTrial(s, r);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
  const scenarioResults = scenarios.map((s) => {
    const trials = results.get(s.id);
    const passes = trials.filter((t) => t.passed).length;
    const hijacks = trials.filter((t) => t.hijacked).length;
    return {
      id: s.id,
      title: s.title,
      category: s.category,
      technique: s.injection.technique || null,
      trifecta: trifecta(s),
      indicators: attackerIndicators(s),
      k,
      passes,
      hijacks,
      pass_hat_k: passes === k,
      asr: ratio(hijacks, k),
      trials,
    };
  });
  return { scenarios: scenarioResults, ...aggregate(scenarioResults) };
}
