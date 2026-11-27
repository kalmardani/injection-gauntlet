// Seeded randomness. Same seed, same canary values and same trial seeds on
// every platform, so a run can be reproduced exactly where the target allows it.

/** FNV-1a 32 bit hash of a string. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 generator. Returns a function giving floats in [0, 1). */
export function rngFromSeed(seed) {
  let a = (typeof seed === 'number' ? seed : hash32(seed)) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomHex(rng, length) {
  let out = '';
  while (out.length < length) out += Math.floor(rng() * 16).toString(16);
  return out;
}

/** Seed for one trial, derived from the run seed, the scenario and the trial index. */
export function trialSeed(runSeed, scenarioId, trial) {
  return hash32(`${runSeed}:${scenarioId}:${trial}`);
}
