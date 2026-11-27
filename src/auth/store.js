// Per user config directory and the token cache file.
// Windows: %APPDATA%\injection-gauntlet
// macOS:   ~/Library/Application Support/injection-gauntlet
// Linux:   $XDG_CONFIG_HOME/injection-gauntlet or ~/.config/injection-gauntlet
// IG_CONFIG_DIR overrides the location (used by the tests).

import { mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function userConfigDir(platform = process.platform, env = process.env) {
  if (env.IG_CONFIG_DIR) return path.resolve(env.IG_CONFIG_DIR);
  const home = os.homedir();
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'injection-gauntlet');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'injection-gauntlet');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'injection-gauntlet');
}

/** JSON file store with owner only permissions where the OS supports it. */
export class TokenStore {
  constructor(dir = userConfigDir()) {
    this.dir = dir;
    this.file = path.join(dir, 'tokens.json');
  }

  readAll() {
    if (!existsSync(this.file)) return {};
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  writeAll(data) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  get(key) {
    return this.readAll()[key] || null;
  }

  set(key, value) {
    const all = this.readAll();
    all[key] = value;
    this.writeAll(all);
  }

  delete(key) {
    const all = this.readAll();
    const had = key in all;
    delete all[key];
    this.writeAll(all);
    return had;
  }
}
