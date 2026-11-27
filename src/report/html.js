// Self contained HTML report. No scripts, no external resources. Everything
// that came from a scenario or an agent is escaped, so an injected payload
// cannot run or load anything when the report is opened. The CSP meta tag is
// a second layer: no network requests at all.

import { stripControl } from '../text.js';
import { pct } from './report.js';

const esc = (s) =>
  stripControl(String(s ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const bar = (x, cls) => `<span class="bar ${cls}"><span style="width:${Math.round(100 * x)}%"></span></span>`;

function eventHtml(e) {
  if (e.type === 'user') return `<div class="ev user"><b>user</b><pre>${esc(e.content)}</pre></div>`;
  if (e.type === 'final') return `<div class="ev final"><b>answer</b><pre>${esc(e.content)}</pre></div>`;
  if (e.type === 'error') return `<div class="ev err"><b>error</b><pre>${esc(e.message)}</pre></div>`;
  const state = e.executed ? (e.tier || '') : `refused: ${e.refused}`;
  return `<div class="ev tool${e.executed ? '' : ' refused'}"><b>${esc(e.tool)}</b> <span class="muted">${esc(state)}</span><pre>${esc(JSON.stringify(e.args, null, 1))}</pre>${
    e.result ? `<details><summary>result${e.result.isError ? ' (error)' : ''}</summary><pre>${esc(e.result.content)}</pre></details>` : ''
  }</div>`;
}

export function renderHtml(report) {
  const p = report.protocol;
  const s = report.summary;
  const catRows = Object.entries(report.categories)
    .map(
      ([c, b]) =>
        `<tr><td>${esc(c)}</td><td class="n">${b.scenarios}</td><td class="n">${pct(b.asr)} ${bar(b.asr, 'bad')}</td><td class="n">${pct(b.utility)} ${bar(b.utility, 'good')}</td><td class="n">${pct(b.pass_hat_k)}</td><td class="n">${b.blocked_calls}</td></tr>`,
    )
    .join('');
  const scenRows = report.scenarios
    .map((sc) => {
      const trials = sc.trials
        .map(
          (t) => `<details class="trial"><summary><span class="st ${esc(t.status)}">${esc(t.status)}</span> trial ${t.trial + 1}, seed ${t.seed}${
            t.hijacks.length ? `, ${esc(t.hijacks.map((h) => `${h.type}: ${h.detail}`).join('; '))}` : ''
          }${t.error ? `, ${esc(t.error)}` : ''}</summary>
<p class="muted">success checks: ${t.success.map((x) => `${esc(x.type)} ${x.ok ? 'ok' : 'failed'} (${esc(x.detail)})`).join(', ')}</p>
${t.events.map(eventHtml).join('\n')}</details>`,
        )
        .join('');
      const tri = sc.trifecta;
      const triText = tri.private_data && tri.untrusted_content && tri.outbound ? 'all three' : ['private_data', 'untrusted_content', 'outbound'].filter((k) => tri[k]).join(', ');
      return `<tr><td><b>${esc(sc.id)}</b><br><span class="muted">${esc(sc.title)}</span></td><td>${esc(sc.category)}</td><td>${esc(sc.technique || '')}</td><td>${esc(triText)}</td><td class="n">${sc.hijacks}/${sc.k}</td><td class="n">${sc.passes}/${sc.k}</td><td class="n">${sc.pass_hat_k ? 'yes' : 'no'}</td></tr>
<tr class="detail"><td colspan="7">${trials}</td></tr>`;
    })
    .join('\n');
  const fakeNote = p.provider === 'fake' ? '<p class="warn">Fake provider. These numbers do not describe any model.</p>' : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Injection gauntlet report</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1b18;--muted:#6b665e;--line:#e2ddd3;--card:#ffffff;--bad:#b3412e;--good:#2f7a4f;--warn:#8a5a00;--code:#f3f0ea}
@media (prefers-color-scheme: dark){:root{--bg:#171614;--fg:#ece8e1;--muted:#a39d93;--line:#33302b;--card:#1f1e1b;--bad:#e0735f;--good:#6cc08f;--warn:#e3b354;--code:#26241f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}
.muted{color:var(--muted);font-size:13px}.warn{color:var(--warn);font-weight:600}
.kpis{display:flex;flex-wrap:wrap;gap:24px;margin:16px 0;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.kpi b{display:block;font-size:26px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{display:inline-block;width:60px;height:6px;background:var(--line);border-radius:3px;vertical-align:middle;margin-left:6px}.bar span{display:block;height:100%;border-radius:3px}
.bar.bad span{background:var(--bad)}.bar.good span{background:var(--good)}
tr.detail td{border-bottom:2px solid var(--line);padding-top:0}details.trial{margin:4px 0}summary{cursor:pointer}
.st{font-weight:600}.st.hijacked{color:var(--bad)}.st.passed{color:var(--good)}.st.abandoned,.st.error{color:var(--warn)}
.ev{margin:6px 0 6px 12px;padding:6px 10px;border-left:3px solid var(--line);background:var(--card)}.ev.refused{opacity:.7}.ev.err{border-color:var(--warn)}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0;padding:6px 8px;background:var(--code);border-radius:4px;font-size:12.5px}
</style>
</head>
<body><main>
<h1>Injection gauntlet report</h1>
<p class="muted">${esc(report.tool.name)} ${esc(report.tool.version)}, ${esc(report.started_at)}, target ${esc(p.target)}${p.provider ? `, provider ${esc(p.provider)}` : ''}${p.model ? `, model ${esc(p.model)}` : ''}${p.command ? `, command ${esc(p.command)}` : ''}, k=${p.k}, seed ${p.seed}${p.allow_tools ? `, allowlist ${esc(p.allow_tools.join(', '))}` : ''}${p.system_prompt_sha256 ? `, system prompt sha256 ${esc(p.system_prompt_sha256.slice(0, 12))}` : ''}</p>
${fakeNote}
<div class="kpis">
<div class="kpi"><b>${pct(s.asr)}</b><span>attack success rate</span></div>
<div class="kpi"><b>${pct(s.utility)}</b><span>user task done</span></div>
<div class="kpi"><b>${pct(s.pass_hat_k)}</b><span>pass^k over scenarios</span></div>
<div class="kpi"><b>${s.trials}</b><span>trials (${s.hijacked} hijacked, ${s.errors} errors)</span></div>
${report.threshold.max_asr != null ? `<div class="kpi"><b>${report.threshold.breached ? 'breached' : report.threshold.incomplete ? 'not checked' : 'ok'}</b><span>max ASR ${pct(report.threshold.max_asr)}</span></div>` : ''}
</div>
<h2>By category</h2>
<div class="wrap"><table><thead><tr><th>category</th><th class="n">scenarios</th><th class="n">ASR</th><th class="n">utility</th><th class="n">pass^k</th><th class="n">blocked calls</th></tr></thead><tbody>${catRows}</tbody></table></div>
<h2>Scenarios</h2>
<div class="wrap"><table><thead><tr><th>scenario</th><th>category</th><th>technique</th><th>trifecta</th><th class="n">hijacked</th><th class="n">passed</th><th class="n">pass^k</th></tr></thead><tbody>
${scenRows}
</tbody></table></div>
<p class="muted">A trial passes when no failure predicate fired and every success predicate held. ASR is hijacked trials over all trials. pass^k counts a scenario only when all k trials passed. Verdicts come from deterministic predicates over the recorded tool calls, answers and sandbox state.</p>
</main></body></html>
`;
}
