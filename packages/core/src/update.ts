import path from "node:path";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { backupStamp } from "./backup.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { isInside } from "./library.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type ManifestSkill, type RemoteSkillInfo } from "./manifest.js";
import {
  discoverSkillOrigin,
  inspectLocalGitSource,
  parseRemoteTarget,
  runGit,
  slugForRemote,
  syncRemoteClone,
  type GitRunner,
  type ParsedRemoteTarget,
  type RemoteSyncResult,
} from "./remote.js";
import { expandSkillNames, replaceHubSkillFromSource } from "./skills.js";
import { refreshSkillsJsonManifests } from "./skills-json.js";
import { refreshLibrarySnapshots } from "./snapshots.js";

export type UpdateItemStatus = "up-to-date" | "updated" | "conflict" | "upstream-missing" | "local-only";

export interface UpdateItem {
  skill: string;
  status: UpdateItemStatus;
  source?: string;
  remoteUrl?: string;
  oldCommit?: string;
  newCommit?: string;
  backup?: string;
  reason?: string;
}

export interface UpdateOptions {
  /** Only inspect/update these skill names or glob patterns (`*`, `?`). */
  skills?: string[];
  profiles?: AgentProfile[];
  git?: GitRunner;
  /** Set false to inspect cached/local checkouts without fetching upstream. */
  fetch?: boolean;
  lock?: LockOptions;
}

export interface UpdatePlan {
  items: UpdateItem[];
}

export interface UpdateResult extends UpdatePlan {
  snapshotFailed: string[];
}

export type UpdateChoice = "overwrite" | "keep";

export interface UpdateDecision {
  skill: string;
  choice: UpdateChoice;
}

export interface UpdateResolution {
  skill: string;
  choice: UpdateChoice;
  ok: boolean;
  backup?: string;
  error?: string;
}

interface ResolvedUpstream {
  item: UpdateItem;
  upstreamDir?: string;
  upstreamHash?: string;
  newCommit?: string;
  backfilledRemote?: RemoteSkillInfo;
}

function selectTargetSkills(allNames: string[], requested?: string[]): string[] {
  if (!requested?.length) return [...allNames].sort();
  const expanded = expandSkillNames(requested, allNames);
  const existing = new Set(allNames);
  for (const name of expanded) {
    if (!existing.has(name)) {
      throw new SkillsymError("SKILL_NOT_IN_HUB", `Skill "${name}" is not in the hub.`, { skill: name });
    }
  }
  return expanded;
}

function targetFromRemoteMeta(remote: NonNullable<ManifestSkill["remote"]>): ParsedRemoteTarget {
  return {
    url: remote.url,
    label: remote.url,
    slug: "", // Filled below using parseRemoteTarget / slugForRemote
    ...(remote.ref ? { ref: remote.ref } : {}),
    subpath: remote.subpath,
  };
}

async function resolveRemoteTargetForEntry(entry: ManifestSkill): Promise<ParsedRemoteTarget> {
  const remote = entry.remote!;
  const parsed = await parseRemoteTarget(remote.ref ? `${remote.url}#${encodeURIComponent(remote.ref)}` : remote.url);
  if (parsed) return { ...parsed, subpath: remote.subpath, ...(remote.ref ? { ref: remote.ref } : {}) };
  const fallback = targetFromRemoteMeta(remote);
  return { ...fallback, slug: slugForRemote(remote.url, remote.ref) };
}

async function evaluateUpdates(hub: Hub, options: UpdateOptions, dryRun: boolean): Promise<ResolvedUpstream[]> {
  const manifest = await readManifest(hub.manifestPath);
  const names = selectTargetSkills(Object.keys(manifest.skills), options.skills);
  if (!names.length) return [];

  const git = options.git ?? runGit;
  const shouldFetch = options.fetch !== false;

  // Deduplicate remote sync calls so multi-skill repositories fetch at most once per run.
  const remoteCache = new Map<string, Promise<RemoteSyncResult>>();
  const localPulled = new Set<string>();

  // Resolve effective remote metadata up front (explicit entry.remote or lazy offline discovery
  // from SKILL.md frontmatter / .skill-lock.json / local git origin).
  const effectiveRemotes = new Map<string, { remote: RemoteSkillInfo; backfilled: boolean }>();
  const localGitByName = new Map<string, Awaited<ReturnType<typeof inspectLocalGitSource>>>();

  for (const name of names) {
    const e = manifest.skills[name]!;
    if (e.remote) {
      effectiveRemotes.set(name, { remote: e.remote, backfilled: false });
      continue;
    }
    const hubSkillDir = path.join(hub.skillsDir, name);
    const localGit = e.source ? await inspectLocalGitSource(e.source, git) : null;
    if (localGit && !isInside(hub.remotesDir, e.source!)) {
      localGitByName.set(name, localGit);
      if (localGit.url) {
        effectiveRemotes.set(name, {
          remote: { url: localGit.url, subpath: localGit.subpath, commit: localGit.commit },
          backfilled: true,
        });
        continue;
      }
    }
    const discovered = await discoverSkillOrigin(name, hubSkillDir, {
      sourceDir: e.source,
      hub,
      profiles: options.profiles,
      git,
    });
    if (discovered) {
      // Clear local-without-origin fallback so update fetches from the discovered online origin.
      localGitByName.delete(name);
      effectiveRemotes.set(name, { remote: discovered, backfilled: true });
    }
  }

  // Detect whether any tracked skill in a remote clone uses --link (`source-link`); during dry-run we
  // avoid advancing a --link clone's checked-out working tree so agents' live folders remain untouched.
  const hasSourceLinkForKey = new Set<string>();
  for (const name of names) {
    const e = manifest.skills[name]!;
    const eff = effectiveRemotes.get(name)?.remote;
    if (eff && e.mode === "source-link") {
      hasSourceLinkForKey.add(`${eff.url}\0${eff.ref ?? ""}`);
    }
  }

  const syncRepoOnce = async (remote: RemoteSkillInfo): Promise<{ repoDir: string; commit: string; dryRunHeadOnly?: string }> => {
    const entryStub: ManifestSkill = { agents: [], mode: "link", scope: "user", remote };
    const target = await resolveRemoteTargetForEntry(entryStub);
    const key = `${target.url}\0${target.ref ?? ""}`;
    if (dryRun && hasSourceLinkForKey.has(key)) {
      const repoDir = path.join(hub.remotesDir, target.slug);
      if (await isDirectory(path.join(repoDir, ".git"))) {
        if (shouldFetch) {
          await git(["fetch", "--quiet", "--tags", "--force", "--prune", "origin"], repoDir);
        }
        const refToCheck = target.ref
          ? await (async () => {
              try {
                return (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${target.ref}`], repoDir)).trim();
              } catch {
                return (await git(["rev-parse", target.ref!], repoDir)).trim();
              }
            })()
          : (await git(["rev-parse", "refs/remotes/origin/HEAD"], repoDir).catch(() => git(["rev-parse", "origin/main"], repoDir))).trim();
        return { repoDir, commit: refToCheck, dryRunHeadOnly: (await git(["rev-parse", "HEAD"], repoDir)).trim() };
      }
    }
    let promise = remoteCache.get(key);
    if (!promise) {
      promise = syncRemoteClone(hub, target, { git, fetch: shouldFetch });
      remoteCache.set(key, promise);
    }
    return promise;
  };

  const results: ResolvedUpstream[] = [];
  for (const name of names) {
    const entry = manifest.skills[name]!;
    const hubSkillDir = path.join(hub.skillsDir, name);
    const effective = effectiveRemotes.get(name);
    const localGit = localGitByName.get(name) ?? null;

    // If source is an existing local git folder with an `origin` (outside hub/remotes), pull/inspect it in place
    // so `--link` local git libraries and editable clones update cleanly.
    if (effective && !localGit) {
      const remote = effective.remote;
      const syncInfo = await syncRepoOnce(remote);
      const upstreamDir = remote.subpath ? path.join(syncInfo.repoDir, remote.subpath) : syncInfo.repoDir;
      const oldCommit = remote.commit || undefined;
      const newCommit = syncInfo.commit;
      const backfilledRemote = effective.backfilled ? { ...remote, commit: newCommit } : undefined;

      if (syncInfo.dryRunHeadOnly !== undefined && newCommit !== oldCommit) {
        results.push({
          item: {
            skill: name,
            status: "updated",
            source: entry.source,
            remoteUrl: remote.url,
            ...(oldCommit ? { oldCommit } : {}),
            newCommit,
          },
          upstreamDir,
          newCommit,
          backfilledRemote,
        });
        continue;
      }

      if (!(await isDirectory(upstreamDir)) || !(await isFile(path.join(upstreamDir, "SKILL.md")))) {
        results.push({
          item: {
            skill: name,
            status: "upstream-missing",
            source: entry.source,
            remoteUrl: remote.url,
            ...(oldCommit ? { oldCommit } : {}),
            newCommit,
            reason: `upstream folder "${remote.subpath || "."}" is missing or has no SKILL.md (local hub copy kept)`,
          },
          newCommit,
          backfilledRemote,
        });
        continue;
      }

      const upstreamHash = await hashSkillDir(upstreamDir);
      if (entry.mode === "source-link") {
        const changed = (entry.sourceHash !== undefined && upstreamHash !== entry.sourceHash) || newCommit !== oldCommit;
        results.push({
          item: {
            skill: name,
            status: changed ? "updated" : "up-to-date",
            source: upstreamDir,
            remoteUrl: remote.url,
            ...(oldCommit ? { oldCommit } : {}),
            newCommit,
          },
          upstreamDir,
          upstreamHash,
          newCommit,
          backfilledRemote,
        });
        continue;
      }

      const hubExists = await isDirectory(hubSkillDir);
      const hubHash = hubExists ? await hashSkillDir(hubSkillDir) : undefined;
      if (hubHash === upstreamHash) {
        results.push({
          item: { skill: name, status: "up-to-date", source: upstreamDir, remoteUrl: remote.url, ...(oldCommit ? { oldCommit } : {}), newCommit },
          upstreamDir,
          upstreamHash,
          newCommit,
          backfilledRemote,
        });
      } else if (entry.sourceHash !== undefined && upstreamHash === entry.sourceHash) {
        // Upstream did not change since the recorded baseline; local hub edits remain safely untouched.
        results.push({
          item: { skill: name, status: "up-to-date", source: upstreamDir, remoteUrl: remote.url, ...(oldCommit ? { oldCommit } : {}), newCommit },
          upstreamDir,
          upstreamHash,
          newCommit,
          backfilledRemote,
        });
      } else if (
        !hubExists ||
        (entry.sourceHash !== undefined && hubHash === entry.sourceHash) ||
        (effective.backfilled && entry.sourceHash === undefined)
      ) {
        results.push({
          item: { skill: name, status: "updated", source: upstreamDir, remoteUrl: remote.url, ...(oldCommit ? { oldCommit } : {}), newCommit },
          upstreamDir,
          upstreamHash,
          newCommit,
          backfilledRemote,
        });
      } else {
        results.push({
          item: {
            skill: name,
            status: "conflict",
            source: upstreamDir,
            remoteUrl: remote.url,
            ...(oldCommit ? { oldCommit } : {}),
            newCommit,
            reason: "modified in the hub since last sync, and upstream also has changes",
          },
          upstreamDir,
          upstreamHash,
          newCommit,
          backfilledRemote,
        });
      }
      continue;
    }

    // Local git source handling (existing git checkout on disk).
    if (!localGit) {
      results.push({
        item: {
          skill: name,
          status: "local-only",
          ...(entry.source ? { source: entry.source } : {}),
          reason: "not linked to a GitHub or git source",
        },
      });
      continue;
    }

    if (!dryRun && shouldFetch && localGit.url && !localPulled.has(localGit.root)) {
      localPulled.add(localGit.root);
      const dirty = (await git(["status", "--porcelain"], localGit.root)).trim();
      if (!dirty) {
        try {
          await git(["pull", "--ff-only", "--quiet"], localGit.root);
        } catch {
          // Local repo may have no upstream tracking branch or be offline; fall back to working tree state.
        }
      }
    }

    const refreshedGit = await inspectLocalGitSource(entry.source!, git);
    const upstreamDir = entry.source!;
    const backfilledRemote = effective?.backfilled ? { ...effective.remote, commit: refreshedGit?.commit ?? localGit.commit } : undefined;
    if (!(await isDirectory(upstreamDir)) || !(await isFile(path.join(upstreamDir, "SKILL.md")))) {
      results.push({
        item: {
          skill: name,
          status: localGit.url ? "upstream-missing" : "local-only",
          source: upstreamDir,
          ...(localGit.url ? { remoteUrl: localGit.url } : {}),
          reason: localGit.url
            ? "source folder in git repo is missing or has no SKILL.md (local hub copy kept)"
            : "local git repo has no origin remote",
        },
        backfilledRemote,
      });
      continue;
    }

    const upstreamHash = await hashSkillDir(upstreamDir);
    const commitNow = refreshedGit?.commit ?? localGit.commit;

    // A local `.git` repository with NO `origin` remote is treated as local-only unless the source
    // folder on disk actually has newer/differing files relative to the hub copy.
    if (!localGit.url) {
      const hubExists = await isDirectory(hubSkillDir);
      const hubHash = hubExists ? await hashSkillDir(hubSkillDir) : undefined;
      if (hubHash === upstreamHash || (entry.sourceHash !== undefined && upstreamHash === entry.sourceHash)) {
        results.push({
          item: {
            skill: name,
            status: "local-only",
            source: upstreamDir,
            reason: "local git repo has no origin remote",
          },
          upstreamDir,
          upstreamHash,
        });
      } else if (!hubExists || (entry.sourceHash !== undefined && hubHash === entry.sourceHash)) {
        results.push({
          item: {
            skill: name,
            status: "updated",
            source: upstreamDir,
            newCommit: commitNow,
          },
          upstreamDir,
          upstreamHash,
          newCommit: commitNow,
        });
      } else {
        results.push({
          item: {
            skill: name,
            status: "conflict",
            source: upstreamDir,
            newCommit: commitNow,
            reason: "modified in both hub and local git source (no origin remote configured)",
          },
          upstreamDir,
          upstreamHash,
          newCommit: commitNow,
        });
      }
      continue;
    }

    if (entry.mode === "source-link") {
      const changed = entry.sourceHash !== undefined && upstreamHash !== entry.sourceHash;
      results.push({
        item: {
          skill: name,
          status: changed ? "updated" : "up-to-date",
          source: upstreamDir,
          remoteUrl: localGit.url,
          newCommit: commitNow,
        },
        upstreamDir,
        upstreamHash,
        newCommit: commitNow,
        backfilledRemote,
      });
      continue;
    }

    const hubExists = await isDirectory(hubSkillDir);
    const hubHash = hubExists ? await hashSkillDir(hubSkillDir) : undefined;
    if (hubHash === upstreamHash || (entry.sourceHash !== undefined && upstreamHash === entry.sourceHash)) {
      results.push({
        item: {
          skill: name,
          status: "up-to-date",
          source: upstreamDir,
          remoteUrl: localGit.url,
          newCommit: commitNow,
        },
        upstreamDir,
        upstreamHash,
        newCommit: commitNow,
        backfilledRemote,
      });
    } else if (!hubExists || (entry.sourceHash !== undefined && hubHash === entry.sourceHash)) {
      results.push({
        item: {
          skill: name,
          status: "updated",
          source: upstreamDir,
          remoteUrl: localGit.url,
          newCommit: commitNow,
        },
        upstreamDir,
        upstreamHash,
        newCommit: commitNow,
        backfilledRemote,
      });
    } else {
      results.push({
        item: {
          skill: name,
          status: "conflict",
          source: upstreamDir,
          remoteUrl: localGit.url,
          newCommit: commitNow,
          reason: "modified in the hub since last sync, and source repo also has changes",
        },
        upstreamDir,
        upstreamHash,
        newCommit: commitNow,
        backfilledRemote,
      });
    }
  }

  return results;
}

/** Preview available updates without modifying hub skills, backups, or `manifest.json`. */
export async function planUpdate(hub: Hub, options: UpdateOptions = {}): Promise<UpdatePlan> {
  const evaluated = await evaluateUpdates(hub, options, true);
  return { items: evaluated.map((e) => e.item) };
}

/**
 * Fetch tracked remote and local-git skills, back up and apply clean updates, and leave locally
 * modified skills untouched as `conflict` items.
 */
export async function updateSkills(hub: Hub, options: UpdateOptions = {}): Promise<UpdateResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const evaluated = await evaluateUpdates(hub, options, false);
      if (!evaluated.length) return { items: [], snapshotFailed: [] };

      const manifest = await readManifest(hub.manifestPath);
      const stamp = backupStamp();
      const snapshotFailed: string[] = [];
      let manifestChanged = false;
      let snapshotsNeedRefresh = false;

      for (const entry of evaluated) {
        const skill = manifest.skills[entry.item.skill];
        if (!skill) continue;

        if (entry.backfilledRemote && !skill.remote) {
          skill.remote = {
            ...entry.backfilledRemote,
            ...(entry.newCommit ? { commit: entry.newCommit } : {}),
          };
          manifestChanged = true;
        }

        if (entry.item.status === "updated" && entry.upstreamDir) {
          if (skill.mode !== "source-link") {
            const backup = await replaceHubSkillFromSource(hub, entry.item.skill, entry.upstreamDir, "update", stamp);
            if (backup) entry.item.backup = backup;
            skill.sourceHash = await hashSkillDir(path.join(hub.skillsDir, entry.item.skill));
          } else {
            skill.sourceHash = entry.upstreamHash ?? (await hashSkillDir(entry.upstreamDir));
            snapshotsNeedRefresh = true;
          }
          if (skill.remote && entry.newCommit) skill.remote.commit = entry.newCommit;
          manifestChanged = true;
        } else if (entry.item.status === "up-to-date" && skill.remote) {
          // Persist commit SHA or baseline sourceHash when hub content matches upstream.
          const hubHash = await hashSkillDir(path.join(hub.skillsDir, entry.item.skill)).catch(() => undefined);
          if (hubHash !== undefined && hubHash === entry.upstreamHash) {
            if (entry.newCommit && skill.remote.commit !== entry.newCommit) {
              skill.remote.commit = entry.newCommit;
              manifestChanged = true;
            }
            if (skill.sourceHash !== entry.upstreamHash) {
              skill.sourceHash = entry.upstreamHash;
              manifestChanged = true;
            }
          }
        }
      }

      if (manifestChanged) {
        await writeManifest(hub.manifestPath, manifest);
        if (snapshotsNeedRefresh) snapshotFailed.push(...(await refreshLibrarySnapshots(hub)));
        await refreshSkillsJsonManifests(hub, options.profiles ?? builtinAgents(), manifest);
      }

      return { items: evaluated.map((e) => e.item), snapshotFailed };
    },
    options.lock,
  );
}

/** Apply interactive user choices (`overwrite` vs `keep`) for `conflict` items returned by `updateSkills`. */
export async function resolveUpdateConflicts(
  hub: Hub,
  decisions: UpdateDecision[],
  options: UpdateOptions = {},
): Promise<UpdateResolution[]> {
  if (!decisions.length) return [];
  return withLock(
    hub.lockPath,
    async () => {
      const manifest = await readManifest(hub.manifestPath);
      const stamp = backupStamp();
      const resolutions: UpdateResolution[] = [];
      let changed = false;

      for (const d of decisions) {
        if (d.choice === "keep") {
          resolutions.push({ skill: d.skill, choice: "keep", ok: true });
          continue;
        }
        const entry = manifest.skills[d.skill];
        if (!entry) {
          resolutions.push({ skill: d.skill, choice: d.choice, ok: false, error: `Skill "${d.skill}" is not in the hub.` });
          continue;
        }
        try {
          let upstreamDir = entry.source;
          let commit: string | undefined;
          if (entry.remote) {
            const target = await resolveRemoteTargetForEntry(entry);
            const synced = await syncRemoteClone(hub, target, { git: options.git, fetch: false });
            upstreamDir = entry.remote.subpath ? path.join(synced.repoDir, entry.remote.subpath) : synced.repoDir;
            commit = synced.commit;
          }
          if (!upstreamDir || !(await isDirectory(upstreamDir)) || !(await isFile(path.join(upstreamDir, "SKILL.md")))) {
            resolutions.push({
              skill: d.skill,
              choice: d.choice,
              ok: false,
              error: `Upstream folder "${upstreamDir ?? "(unknown)"}" is no longer available.`,
            });
            continue;
          }
          const backup = await replaceHubSkillFromSource(hub, d.skill, upstreamDir, "update-conflict", stamp);
          entry.source = upstreamDir;
          entry.sourceHash = await hashSkillDir(path.join(hub.skillsDir, d.skill));
          if (entry.remote && commit) entry.remote.commit = commit;
          changed = true;
          resolutions.push({ skill: d.skill, choice: "overwrite", ok: true, ...(backup ? { backup } : {}) });
        } catch (err) {
          resolutions.push({
            skill: d.skill,
            choice: d.choice,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (changed) {
        await writeManifest(hub.manifestPath, manifest);
        await refreshSkillsJsonManifests(hub, options.profiles ?? builtinAgents(), manifest);
      }
      return resolutions;
    },
    options.lock,
  );
}
