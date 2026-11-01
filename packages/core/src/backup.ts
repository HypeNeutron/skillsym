import { promises as fs } from "node:fs";
import path from "node:path";
import type { Hub } from "./hub.js";
import { readLinkTarget, removeDirLink } from "./links.js";

/** Names one operation's folder under the hub's backups; share it to keep a whole import together. */
export function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** A timestamped folder under the hub's backups for one operation. */
export function backupPath(hub: Hub, label: string, name: string, stamp: string = backupStamp()): string {
  return path.join(hub.backupsDir, stamp, label || "unassigned", name);
}

/** Move a folder into backups (rename, or copy-then-delete across volumes). Returns where it went. */
export async function moveToBackup(hub: Hub, from: string, label: string, name: string, stamp?: string): Promise<string> {
  const dest = backupPath(hub, label, name, stamp);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(from, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    // Remove the original only after the copy succeeded.
    await fs.cp(from, dest, { recursive: true, errorOnExist: true });
    await fs.rm(from, { recursive: true });
  }
  return dest;
}

/**
 * Get whatever occupies `p` out of the way without losing it: a link is simply removed (its target
 * is untouched); a real folder or file is moved into the hub's backups. Returns the backup path,
 * if one was made.
 */
export async function moveAside(hub: Hub, p: string, label: string, name: string): Promise<string | undefined> {
  if ((await readLinkTarget(p)) !== null) {
    await removeDirLink(p);
    return undefined;
  }
  return moveToBackup(hub, p, label, name);
}
