import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDirectory, pathExists } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest } from "./manifest.js";
import { readState, samePath, writeState } from "./state.js";

export type EjectOutcome =
  /** Our link was replaced by a real copy of the skill. */
  | "ejected"
  /** Something else is at the path now; left alone. */
  | "left-in-place"
  /** Nothing is at the path any more; just forgotten. */
  | "missing"
  /** The hub has no folder to copy for this link; the link was left alone. */
  | "hub-missing"
  | "failed";

export interface EjectResult {
  skill: string;
  path: string;
  outcome: EjectOutcome;
  error?: string;
}

export interface EjectReport {
  results: EjectResult[];
  /** The hub folder, which eject never deletes. */
  hubHome: string;
}

export interface EjectOptions {
  dryRun?: boolean;
  lock?: LockOptions;
}

const STAGING_PREFIX = ".skillsym-eject-";

/**
 * Stop using skillsym without losing anything: every link skillsym created is replaced by a real
 * copy of the skill, so agents keep working even if the hub is deleted afterwards. Paths that no
 * longer hold our link are left alone. Progress is saved after every link, so an interrupted eject
 * can be run again. The hub itself is never deleted.
 */
export async function eject(hub: Hub, options: EjectOptions = {}): Promise<EjectReport> {
  return withLock(
    hub.lockPath,
    async () => {
      const state = await readState(hub.statePath);
      const results: EjectResult[] = [];
      const dirs = new Set<string>();

      for (const link of [...state.links]) {
        dirs.add(path.dirname(link.path));
        const hubCopy = path.join(hub.skillsDir, link.skill);
        const onDisk = await readLinkTarget(link.path);
        const ours = onDisk !== null && (samePath(onDisk, hubCopy) || samePath(onDisk, link.target));
        let outcome: EjectOutcome;
        if (!ours) outcome = (await pathExists(link.path)) ? "left-in-place" : "missing";
        else if (!(await isDirectory(onDisk!))) outcome = (await isDirectory(hubCopy)) ? "ejected" : "hub-missing";
        else outcome = "ejected";

        const result: EjectResult = { skill: link.skill, path: link.path, outcome };
        results.push(result);
        if (options.dryRun || outcome === "hub-missing") continue;

        try {
          if (outcome === "ejected") {
            // Resolve links (a --link skill is agent -> hub -> library) so real files are copied.
            const source = await fs.realpath((await isDirectory(onDisk!)) ? onDisk! : hubCopy);
            await replaceLinkWithCopy(link.path, source);
          }
          state.links = state.links.filter((l) => !samePath(l.path, link.path));
          await writeState(hub.statePath, state);
        } catch (err) {
          result.outcome = "failed";
          result.error = (err as Error).message;
        }
      }

      if (!options.dryRun) {
        await clearAssignments(hub, results);
        for (const dir of dirs) await removeStaleStaging(dir);
      }
      return { results, hubHome: hub.home };
    },
    options.lock,
  );
}

/**
 * Copy first (next to the link, so the final rename stays on one volume), then swap: the link is
 * only removed once a complete copy exists.
 */
async function replaceLinkWithCopy(linkPath: string, source: string): Promise<void> {
  const staging = path.join(path.dirname(linkPath), `${STAGING_PREFIX}${randomBytes(6).toString("hex")}`);
  await fs.cp(source, staging, { recursive: true, errorOnExist: true });
  try {
    await removeDirLink(linkPath);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }
  await fs.rename(staging, linkPath);
}

/**
 * Once every link of a skill is ejected, its assignments no longer mean anything; clear them so a
 * later `status` shows the agents' copies as unmanaged rather than as drift.
 */
async function clearAssignments(hub: Hub, results: EjectResult[]): Promise<void> {
  const state = await readState(hub.statePath);
  const manifest = await readManifest(hub.manifestPath);
  let changed = false;
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (!entry.agents.length || state.links.some((l) => l.skill === name)) continue;
    if (results.some((r) => r.skill === name && r.outcome === "failed")) continue;
    entry.agents = [];
    changed = true;
  }
  if (changed) await writeManifest(hub.manifestPath, manifest);
}

/** Remove half-made copies left by an eject that was interrupted. */
async function removeStaleStaging(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
  }
}
