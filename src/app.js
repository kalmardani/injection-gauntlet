// Glue between configuration and the runner, shared by the CLI and the MCP server.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createProvider } from './providers/index.js';
import { referenceTarget, readPromptFile, DEFAULT_SYSTEM_PROMPT_FILE } from './targets/reference.js';
import { commandTarget } from './targets/command.js';
import { httpTarget } from './targets/http.js';
import { loadScenarios, selectScenarios, BUILTIN_SCENARIO_DIR } from './scenario.js';
import { runSuite } from './runner.js';
import { buildReport } from './report/report.js';
import { renderHtml } from './report/html.js';
import { sha256Hex } from './text.js';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const TOOL = { name: 'injection-gauntlet', version: VERSION };

export function buildTarget(cfg, { fetchImpl } = {}) {
  if (cfg.target === 'reference') {
    const provider = createProvider({
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.base_url,
      auth: cfg.auth,
      apiKeyEnv: cfg.api_key_env,
      oauthConfigFile: cfg.oauth_config,
      timeoutMs: cfg.timeout_ms,
      temperature: cfg.temperature ?? undefined,
      maxTokens: cfg.max_tokens,
      fakeScriptFile: cfg.fake_script,
      fetchImpl,
    });
    const systemPrompt = readPromptFile(cfg.system_prompt_file || DEFAULT_SYSTEM_PROMPT_FILE);
    return { target: referenceTarget({ provider, systemPrompt }), systemPrompt, provider, passSystemToTarget: false };
  }
  const systemPrompt = cfg.system_prompt_file ? readPromptFile(cfg.system_prompt_file) : null;
  if (cfg.target === 'command') return { target: commandTarget({ command: cfg.command, timeoutMs: cfg.timeout_ms }), systemPrompt, passSystemToTarget: true };
  return {
    target: httpTarget({ url: cfg.url, timeoutMs: cfg.timeout_ms, token: process.env.IG_HTTP_TOKEN || undefined, fetchImpl }),
    systemPrompt,
    passSystemToTarget: true,
  };
}

export function selectFromConfig(cfg) {
  const all = loadScenarios(cfg.scenarios?.length ? cfg.scenarios : [BUILTIN_SCENARIO_DIR]);
  return selectScenarios(all, { only: cfg.only || [], categories: cfg.category || [] });
}

/** Run the configured suite. Returns { report, files }. */
export async function executeRun(cfg, { onTrial, scenarios, fetchImpl } = {}) {
  const list = scenarios || selectFromConfig(cfg);
  if (!list.length) throw new Error('no scenarios match the selection');
  const { target, systemPrompt, provider, passSystemToTarget } = buildTarget(cfg, { fetchImpl });
  const startedAt = new Date().toISOString();
  const suite = await runSuite({
    scenarios: list,
    target,
    k: cfg.k,
    seed: cfg.seed,
    systemPrompt: passSystemToTarget ? systemPrompt : null,
    allowTools: cfg.allow_tools,
    limits: { maxSteps: cfg.max_steps, maxToolCalls: cfg.max_tool_calls, trialTimeoutMs: cfg.trial_timeout_ms },
    concurrency: cfg.concurrency,
    onTrial,
  });
  const desc = target.describe();
  const protocol = {
    ...desc,
    model: provider?.model ?? desc.model ?? null,
    k: cfg.k,
    seed: cfg.seed,
    scenario_count: list.length,
    scenario_ids: list.map((s) => s.id),
    max_steps: cfg.max_steps,
    max_tool_calls: cfg.max_tool_calls,
    temperature: cfg.temperature,
    allow_tools: cfg.allow_tools,
    system_prompt_file: cfg.system_prompt_file ? path.basename(cfg.system_prompt_file) : cfg.target === 'reference' ? 'reference-agent.txt' : null,
    system_prompt_sha256: systemPrompt ? sha256Hex(systemPrompt) : null,
    node: process.version,
    platform: process.platform,
  };
  const report = buildReport({ suite, protocol, tool: TOOL, startedAt, finishedAt: new Date().toISOString(), threshold: { max_asr: cfg.max_asr } });
  const files = writeReports(report, cfg);
  return { report, files };
}

export function writeReports(report, cfg) {
  const files = {};
  let jsonPath = cfg.json;
  let htmlPath = cfg.html;
  if (cfg.out) {
    mkdirSync(cfg.out, { recursive: true });
    jsonPath ||= path.join(cfg.out, 'report.json');
    htmlPath ||= path.join(cfg.out, 'report.html');
  }
  if (jsonPath) {
    mkdirSync(path.dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    files.json = jsonPath;
  }
  if (htmlPath) {
    mkdirSync(path.dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, renderHtml(report));
    files.html = htmlPath;
  }
  return files;
}
