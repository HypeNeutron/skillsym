import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDirectory, pathExists } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { readManifest } from "./manifest.js";

/**
 * A --link skill's only real copy is in the user's library. The hub keeps the latest snapshot of each,
 * so a deleted library can be brought back. One version per skill, as of the last `add --link` or `sync`;
 * it is a safety net, not history.
 */
export function librarySnapshotDir(hub: Hub, skill: string): string {
  return path.join(hub.home, "library-snapshots", skill);
}

export async function hasLibrarySnapshot(hub: Hub, skill: string): Promise<boolean> {
  return isDirectory(librarySnapshotDir(hub, skill));
}

/** Update the snapshot of every --link skill whose library folder is there and has changed. Returns those that failed. */
export async function refreshLibrarySnapshots(hub: Hub): Promise<string[]> {
  const manifest = await readManifest(hub.manifestPath);
  const failed: string[] = [];
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (entry.mode !== "source-link" || !entry.source || !(await isDirectory(entry.source))) continue;
    const dest = librarySnapshotDir(hub, name);
    const staging = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      if ((await isDirectory(dest)) && (await hashSkillDir(dest)) === (await hashSkillDir(entry.source))) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(entry.source, staging, { recursive: true, errorOnExist: true });
      await fs.rm(dest, { recursive: true, force: true });
      await fs.rename(staging, dest);
    } catch {
      await fs.rm(staging, { recursive: true, force: true });
      failed.push(name);
    }
  }
  return failed;
}

/** Put a skill's snapshot back where the library had it. Never overwrites: a folder already there is left alone. */
export async function restoreLibrarySkill(hub: Hub, skill: string, source: string): Promise<void> {
  if (await pathExists(source)) return;
  if (!(await hasLibrarySnapshot(hub, skill))) throw new Error(`skillsym has no snapshot of "${skill}"`);
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.cp(librarySnapshotDir(hub, skill), source, { recursive: true, errorOnExist: true });
}

/** The skill left the hub: its snapshot has nothing left to protect. */
export async function removeLibrarySnapshot(hub: Hub, skill: string): Promise<void> {
  await fs.rm(librarySnapshotDir(hub, skill), { recursive: true, force: true });
}
