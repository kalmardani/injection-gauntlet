// Command line interface. Every feature is reachable from here.
// Exit codes: 0 done and under threshold, 1 threshold breached,
// 2 usage or configuration error, 3 nothing measured, runtime failure, or a
// --max-asr check over a run with errored trials (fails closed).

import { parseArgs, resolveConfig } from './config.js';
import { ConfigError } from './providers/index.js';
import { executeRun, VERSION } from './app.js';
import { loadScenarios, BUILTIN_SCENARIO_DIR, CATEGORIES, attackerIndicators, trifecta } from './scenario.js';
import { summaryText, trialLine, compareText, readReport } from './report/report.js';
import { renderHtml } from './report/html.js';
import { writeFileSync } from 'node:fs';
import { loadOAuthConfig, OAuthClient, AuthError } from './auth/oauth.js';
import { loginSubscription, cliInstalled, cliSignedIn } from './auth/subscription.js';
import { runMcpServer } from './mcp.js';
import { stripControl } from './text.js';

export const HELP = `injection-gauntlet ${VERSION}
Measures how easily an AI agent is hijacked by prompt injection, with simulated tools only.

Usage
  injection-gauntlet run [options] [-- agent command...]
  injection-gauntlet list [--category c] [--scenarios dir]
  injection-gauntlet show <scenario-id> [--scenarios dir]
  injection-gauntlet validate [files or folders...]
  injection-gauntlet compare <report.json> <report.json> [...]
  injection-gauntlet report <report.json> --html <out.html>
  injection-gauntlet auth login <claude|chatgpt|oauth> [--oauth-config file]
  injection-gauntlet auth status [--oauth-config file] [--api-key-env NAME]
  injection-gauntlet auth logout oauth [--oauth-config file]
  injection-gauntlet mcp [run options that fix the target]
  injection-gauntlet --version | --help

Targets (--target)
  reference   built in agent loop over a model provider (default)
  command     your agent program, line delimited JSON over stdin and stdout
  http        your agent endpoint, one JSON POST per step

Run options
  --provider p          openai | anthropic | claude-cli | codex-cli | fake
  --model id            model id, passed as is
  --base-url url        OpenAI compatible or Messages API base URL
  --auth kind           api-key | oauth | none | subscription
  --api-key-env NAME    env var holding the key (default OPENAI_API_KEY or ANTHROPIC_API_KEY)
  --oauth-config file   OAuth client config (JSON)
  --url url             endpoint for the http target
  --config file         JSON file with any of these options
  --scenarios path      scenario file or folder, repeatable (default: built in set)
  --only id[,id]        run only these scenario ids (a trailing * matches a prefix)
  --category c[,c]      run only these categories
  --k n                 trials per scenario (default 1)
  --seed n              run seed (default 1)
  --max-asr x           fail with exit code 1 when overall ASR is above x (0.1 or 10%)
  --out dir             write report.json and report.html into dir
  --json file, --html file
  --system-prompt-file f  system prompt for the reference agent (passed to external agents too)
  --allow-tools a,b     offer only these tools; other calls are refused and counted as blocked
  --max-steps n         tool calls per turn (default 10)
  --max-tool-calls n    tool calls per trial (default 30)
  --timeout ms          per model call or agent reply (default 120000)
  --trial-timeout ms    per trial (default 600000)
  --concurrency n       parallel trials (default 1)
  --temperature x, --max-tokens n
  --fake-script file    scripted responses for the fake provider (tests and wiring checks only)
  --quiet               print only the summary

Categories: ${CATEGORIES.join(', ')}
`;

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

async function cmdRun(flags, rest) {
  const cfg = resolveConfig({ flags, rest });
  const { report, files } = await executeRun(cfg, {
    onTrial: (s, t) => {
      if (!cfg.quiet) err(trialLine(s, t, cfg.k));
    },
  });
  out(summaryText(report));
  if (files.json) out(`report ${files.json}`);
  if (files.html) out(`report ${files.html}`);
  if (report.summary.trials > 0 && report.summary.errors === report.summary.trials) {
    err('every trial ended in an error, nothing was measured');
    return 3;
  }
  if (report.threshold.breached) return 1;
  if (report.threshold.max_asr != null && report.threshold.incomplete) {
    err(`${report.summary.errors} trials ended in an error, so the --max-asr check fails closed`);
    return 3;
  }
  return 0;
}

function cmdList(flags) {
  const scen = flags.scenarios?.length ? flags.scenarios : [BUILTIN_SCENARIO_DIR];
  const cats = (flags.category || []).flatMap((c) => c.split(','));
  const all = loadScenarios(scen).filter((s) => !cats.length || cats.includes(s.category));
  for (const s of all) out(`${s.id.padEnd(30)} ${s.category.padEnd(22)} ${s.title}`);
  out(`${all.length} scenarios`);
  return 0;
}

function cmdShow(positionals, flags) {
  const id = positionals[0];
  if (!id) throw new ConfigError('show needs a scenario id');
  const scen = flags.scenarios?.length ? flags.scenarios : [BUILTIN_SCENARIO_DIR];
  const s = loadScenarios(scen).find((x) => x.id === id);
  if (!s) throw new ConfigError(`no scenario with id ${id}`);
  const { source, ...rest } = s;
  out(JSON.stringify({ ...rest, derived: { indicators: attackerIndicators(s), trifecta: trifecta(s) } }, null, 2));
  return 0;
}

function cmdValidate(positionals) {
  const paths = positionals.length ? positionals : [BUILTIN_SCENARIO_DIR];
  let bad = 0;
  let good = 0;
  for (const p of paths) {
    try {
      const list = loadScenarios([p]);
      good += list.length;
    } catch (e) {
      bad += 1;
      err(e.message);
    }
  }
  out(`${good} valid scenarios${bad ? `, ${bad} path(s) with errors` : ''}`);
  return bad ? 2 : 0;
}

function cmdCompare(positionals) {
  if (positionals.length < 2) throw new ConfigError('compare needs at least two report files');
  const reports = positionals.map((f) => readReport(f));
  const names = positionals.map((f) => f.replace(/\\/g, '/').split('/').slice(-2).join('/'));
  out(compareText(reports, names));
  return 0;
}

function cmdReport(positionals, flags) {
  if (!positionals[0] || !flags.html) throw new ConfigError('report needs a report.json and --html <out.html>');
  writeFileSync(flags.html, renderHtml(readReport(positionals[0])));
  out(`report ${flags.html}`);
  return 0;
}

async function cmdAuth(positionals, flags) {
  const [sub, which] = positionals;
  const oauthFile = flags['oauth-config'];
  if (sub === 'login') {
    if (which === 'claude' || which === 'chatgpt') {
      const r = await loginSubscription(which, { log: err });
      return r.ok ? 0 : 3;
    }
    if (which === 'oauth') {
      const cfg = loadOAuthConfig({ file: oauthFile });
      if (!cfg) throw new ConfigError('no OAuth config; pass --oauth-config or set IG_OAUTH_CONFIG or IG_OAUTH_* variables');
      const entry = await new OAuthClient(cfg, { log: err }).login();
      out(`signed in with ${cfg.grant}, token valid until ${new Date(entry.expires_at).toISOString()}`);
      return 0;
    }
    throw new ConfigError('auth login needs claude, chatgpt or oauth');
  }
  if (sub === 'logout') {
    if (which === 'oauth') {
      const cfg = loadOAuthConfig({ file: oauthFile });
      if (!cfg) throw new ConfigError('no OAuth config found');
      out(new OAuthClient(cfg).logout() ? 'cached OAuth token removed' : 'no cached OAuth token');
      return 0;
    }
    if (which === 'claude') out('Sign out with the official CLI: claude auth logout');
    else if (which === 'chatgpt') out('Sign out with the official CLI: codex logout');
    else throw new ConfigError('auth logout needs oauth, claude or chatgpt');
    return 0;
  }
  if (sub === 'status') {
    const keyNames = [...new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', ...(flags['api-key-env'] ? [flags['api-key-env']] : [])])];
    out('api-key');
    for (const n of keyNames) out(`  ${n.padEnd(22)} ${process.env[n] ? 'ready (set)' : 'not set'}`);
    out('oauth');
    try {
      const cfg = loadOAuthConfig({ file: oauthFile });
      if (!cfg) out('  not configured');
      else {
        const st = new OAuthClient(cfg).status();
        out(`  grant ${cfg.grant}, token host ${new URL(cfg.token_url).host}`);
        if (!st.signed_in) out(cfg.grant === 'client_credentials' ? '  no cached token, one is fetched on first use' : '  not signed in, run: injection-gauntlet auth login oauth');
        else out(`  ${st.valid ? 'ready' : 'expired'}, valid until ${st.expires_at}${st.refreshable ? ', refreshable' : ''}`);
      }
    } catch (e) {
      out(`  config error: ${e.message}`);
    }
    for (const [which, label, adapter] of [
      ['claude', 'claude CLI (Claude subscription)', 'claude-cli'],
      ['chatgpt', 'codex CLI (ChatGPT subscription)', 'codex-cli'],
    ]) {
      out(label);
      const inst = await cliInstalled(which);
      if (!inst.installed) {
        out(`  not installed, see: injection-gauntlet auth login ${which}`);
        continue;
      }
      const signed = await cliSignedIn(which);
      out(`  installed ${inst.version}, ${signed ? `signed in, ready for --provider ${adapter}` : `not signed in, run: injection-gauntlet auth login ${which}`}`);
    }
    return 0;
  }
  throw new ConfigError('auth needs login, status or logout');
}

export async function main(argv) {
  let parsed;
  try {
    if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
      out(VERSION);
      return 0;
    }
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
      out(HELP);
      return 0;
    }
    const [command, ...restArgs] = argv;
    parsed = parseArgs(restArgs);
    if (parsed.flags.help) {
      out(HELP);
      return 0;
    }
    switch (command) {
      case 'run':
        return await cmdRun(parsed.flags, parsed.rest);
      case 'list':
        return cmdList(parsed.flags);
      case 'show':
        return cmdShow(parsed.positionals, parsed.flags);
      case 'validate':
        return cmdValidate(parsed.positionals);
      case 'compare':
        return cmdCompare(parsed.positionals);
      case 'report':
        return cmdReport(parsed.positionals, parsed.flags);
      case 'auth':
        return await cmdAuth(parsed.positionals, parsed.flags);
      case 'mcp': {
        const cfg = resolveConfig({ flags: parsed.flags, rest: parsed.rest, allowIncomplete: true });
        await runMcpServer({ cfg });
        return 0;
      }
      default:
        throw new ConfigError(`unknown command ${command}; see injection-gauntlet --help`);
    }
  } catch (e) {
    if (e instanceof ConfigError || e instanceof AuthError) {
      err(`error: ${stripControl(e.message)}`);
      return 2;
    }
    err(`error: ${stripControl(e?.message || String(e))}`);
    return 3;
  }
}
