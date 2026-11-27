// Repository hygiene: house style rules and licence, checked on every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules']);

function files(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(js|json|md|txt|yml|yaml)$|^LICENSE$|^\.git\w+$|^\.editorconfig$/.test(name)) out.push(full);
  }
  return out;
}

const all = files();
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

test('no em dash or en dash anywhere', () => {
  const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]|&` + 'mdash;|&' + 'ndash;');
  const bad = all.filter((f) => dashes.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(rel), []);
});

test('no invisible characters outside the scenarios that test them', () => {
  const bad = all.filter((f) => !rel(f).startsWith('scenarios/') && /[\u200B-\u200F\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/u.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(rel), []);
});

test('no AI co-author or generated-with lines', () => {
  const pattern = new RegExp(['co-authored' + '-by', 'generated' + ' with'].join('|'), 'i');
  const bad = all.filter((f) => pattern.test(readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(rel), []);
});

test('licence and package metadata', () => {
  const lic = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').split('\n');
  assert.deepEqual(lic.slice(0, 3), ['MIT License', '', 'Copyright (c) 2026 Kalmár Dániel']);
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.node, '>=22.5');
  assert.equal(pkg.repository, 'github:kalmardani/injection-gauntlet');
  assert.ok(!pkg.dependencies && !pkg.devDependencies, 'zero dependencies');
});

test('source spawns processes only with shell false', () => {
  for (const f of all.filter((x) => rel(x).startsWith('src/') || rel(x).startsWith('examples/'))) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/shell:\s*true/.test(src), `${rel(f)} uses shell: true`);
    assert.ok(!/\bexec(Sync)?\(/.test(src), `${rel(f)} uses exec`);
  }
});
