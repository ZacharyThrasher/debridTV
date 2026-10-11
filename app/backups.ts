// Scheduled settings backups (N-27c): once a day the same file "Export settings"
// gives you is written to <data folder>/backups, and the newest few are kept.
// Settings only: never keys, library facts or viewing history. Nothing leaves this PC.

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const NAME = /^settings-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/;
export const DAY_MS = 24 * 3_600_000;

export interface BackupInfo {
  name: string;
  at: number;
  bytes: number;
}

export function listBackups(dir: string): BackupInfo[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => NAME.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, at: st.mtimeMs, bytes: st.size };
    })
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

/** Write a backup if the newest is a day old (or `force`), then keep only the newest `keep`. */
export function backupIfDue(dir: string, data: unknown, now: number, keep: number, force = false): BackupInfo | null {
  if (keep <= 0 && !force) return null;
  const list = listBackups(dir);
  if (!force && list[0] && now - list[0].at < DAY_MS) return null;
  mkdirSync(dir, { recursive: true });
  const day = new Date(now).toISOString().slice(0, 10);
  let name = `settings-${day}.json`;
  for (let i = 2; list.some((b) => b.name === name); i++) name = `settings-${day}-${i}.json`;
  const tmp = join(dir, `${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, join(dir, name));
  for (const old of listBackups(dir).slice(Math.max(1, keep))) unlinkSync(join(dir, old.name));
  return listBackups(dir).find((b) => b.name === name) ?? null;
}

export function readBackup(dir: string, name: string): unknown | null {
  if (!NAME.test(name)) return null;
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return null;
  }
}
