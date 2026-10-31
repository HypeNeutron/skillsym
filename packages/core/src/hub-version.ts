import { promises as fs } from "node:fs";
import path from "node:path";
import { backupPath, moveToBackup } from "./backup.js";
import { isDirectory } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { placeInHub } from "./import.js";
import { readManifest } from "./manifest.js";

export interface ReplaceResult {
  backups: string[];
  /** Set when the new version was written into the user's library (a --link skill). */
  library?: string;
}

/**
 * Make `from` the new content of hub skill `name`, backing up the current version first.
 * For a skill linked from the user's library, the library folder is the source of truth, so the
 * new content is written there (the folder itself is kept, only its contents change); the hub link
 * is left alone. Otherwise the hub folder is moved to backups and replaced.
 */
export async function replaceHubVersion(hub: Hub, name: string, from: string): Promise<ReplaceResult> {
  const entry = (await readManifest(hub.manifestPath)).skills[name];
  if (entry?.mode === "source-link" && entry.source && (await isDirectory(entry.source))) {
    const library = entry.source;
    const backup = backupPath(hub, "library", name);
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.cp(library, backup, { recursive: true, errorOnExist: true });
    for (const child of await fs.readdir(library)) await fs.rm(path.join(library, child), { recursive: true, force: true });
    await fs.cp(from, library, { recursive: true, force: true });
    return { backups: [backup], library };
  }
  const hubDir = path.join(hub.skillsDir, name);
  const backups = (await isDirectory(hubDir)) ? [await moveToBackup(hub, hubDir, "hub", name)] : [];
  await placeInHub(hub, name, from);
  return { backups };
}
