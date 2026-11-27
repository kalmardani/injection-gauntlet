// JSON report, terminal summary and the compare view.

import { readFileSync } from 'node:fs';
import { stripControl } from '../text.js';

export const REPORT_SCHEMA_ID = 'injection-gauntlet/report@1';

export function buildReport({ suite, protocol, tool, startedAt, finishedAt, threshold }) {
  const tokens = { input: 0, output: 0 };
  let cost = 0;
  let costKnown = false;
  for (const s of suite.scenarios) {
    for (const t of s.trials) {
      tokens.input += t.usage?.inputTokens || 0;
      tokens.output += t.usage?.outputTokens || 0;
      if (t.usage?.costUsd) {
        cost += t.usage.costUsd;
        costKnown = true;
      }
    }
  }
  const breached = threshold?.max_asr != null ? suite.summary.asr > threshold.max_asr : false;
  return {
    schema: REPORT_SCHEMA_ID,
    tool,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
    protocol,
    summary: { ...suite.summary, tokens, cost_usd: costKnown ? Number(cost.toFixed(6)) : null },
    categories: suite.categories,
    threshold: { max_asr: threshold?.max_asr ?? null, breached },
    scenarios: suite.scenarios,
  };
}

export function readReport(file) {
  const r = JSON.parse(readFileSync(file, 'utf8'));
  if (r.schema !== REPORT_SCHEMA_ID) throw new Error(`${file} is not an injection-gauntlet report`);
  return r;
}

export const pct = (x) => `${(100 * x).toFixed(1)}%`;

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

export function trialLine(scenario, t, k) {
  const why = t.hijacks.length ? t.hijacks.map((h) => `${h.type}: ${h.detail}`).join('; ') : t.error ? t.error : t.success.filter((s) => !s.ok).map((s) => s.detail).join('; ');
  return stripControl(`[${pad(t.status, 9)}] ${scenario.id} trial ${t.trial + 1}/${k}${why ? `  ${why}` : ''}`).slice(0, 300);
}

export function summaryText(report) {
  const p = report.protocol;
  const lines = [];
  lines.push(`Target ${p.target}${p.provider ? `, provider ${p.provider}` : ''}${p.model ? `, model ${p.model}` : ''}${p.command ? `, command ${p.command}` : ''}`);
  lines.push(`k=${p.k}, seed=${p.seed}, ${p.scenario_count} scenarios, ${report.summary.trials} trials${p.allow_tools ? `, allowlist ${p.allow_tools.join(',')}` : ''}`);
  if (p.provider === 'fake') lines.push('Fake provider: these numbers do not describe any model.');
  lines.push('');
  lines.push(`${pad('category', 22)}${lpad('scen', 5)}${lpad('ASR', 8)}${lpad('utility', 9)}${lpad('pass^k', 9)}${lpad('blocked', 9)}`);
  const row = (name, b) => `${pad(name, 22)}${lpad(b.scenarios, 5)}${lpad(pct(b.asr), 8)}${lpad(pct(b.utility), 9)}${lpad(pct(b.pass_hat_k), 9)}${lpad(b.blocked_calls, 9)}`;
  for (const [c, b] of Object.entries(report.categories)) lines.push(row(c, b));
  lines.push(row('all', report.summary));
  lines.push('');
  const s = report.summary;
  lines.push(`hijacked ${s.hijacked}, passed ${s.passed}, abandoned ${s.abandoned}, errors ${s.errors} of ${s.trials} trials`);
  lines.push(`tokens in ${s.tokens.input}, out ${s.tokens.output}${s.cost_usd != null ? `, reported cost ${s.cost_usd.toFixed(4)} USD` : ''}`);
  if (report.threshold.max_asr != null) {
    lines.push(`max ASR ${pct(report.threshold.max_asr)}: ${report.threshold.breached ? 'BREACHED' : 'ok'}`);
  }
  return lines.join('\n');
}

/** Side by side ASR and utility of several reports, per category. */
export function compareText(reports, names) {
  const cats = [...new Set(reports.flatMap((r) => Object.keys(r.categories)))].sort();
  const w = 16;
  const head = `${pad('category', 22)}${names.map((n) => lpad(n.slice(0, w - 1), w)).join('')}`;
  const lines = ['ASR (attack success rate, lower is better)', head];
  for (const c of [...cats, 'all']) {
    lines.push(`${pad(c, 22)}${reports.map((r) => lpad((c === 'all' ? r.summary : r.categories[c]) ? pct((c === 'all' ? r.summary : r.categories[c]).asr) : '-', w)).join('')}`);
  }
  lines.push('', 'utility (user task done, higher is better)', head);
  for (const c of [...cats, 'all']) {
    lines.push(`${pad(c, 22)}${reports.map((r) => lpad((c === 'all' ? r.summary : r.categories[c]) ? pct((c === 'all' ? r.summary : r.categories[c]).utility) : '-', w)).join('')}`);
  }
  lines.push('', `${pad('trials', 22)}${reports.map((r) => lpad(r.summary.trials, w)).join('')}`);
  lines.push(`${pad('k', 22)}${reports.map((r) => lpad(r.protocol.k, w)).join('')}`);
  return lines.join('\n');
}
