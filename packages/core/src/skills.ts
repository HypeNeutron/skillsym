import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentProfile } from "./agents.js";
import { moveToBackup } from "./backup.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile, pathExists, renameWithRetry } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type Manifest, type RemoteSkillInfo, type SkillMode, type SkillScope } from "./manifest.js";
import { discoverSkillOrigin, discoverSkillUpstreams, type GitRunner } from "./remote.js";

export interface SkillInfo {
  name: string;
  /** Real folder inside the hub. */
  path: string;
  agents: string[];
  mode: SkillMode;
  scope: SkillScope;
  /** Where the skill came from; for a --link skill, the library folder it links to. */
  source?: string;
  /** Upstream git provenance when installed from or attached to GitHub/git. */
  remote?: RemoteSkillInfo;
  /** Watched upstream sources for combined/orchestrator skills. */
  upstreams?: RemoteSkillInfo[];
}

export interface AddSkillOptions {
  profiles?: AgentProfile[];
  git?: GitRunner;
  lock?: LockOptions;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function isValidSkillName(name: string): boolean {
  return NAME_PATTERN.test(name) && !name.endsWith(".");
}

/**
 * Expand name patterns ("*" any characters, "?" one) against `names`. Plain names pass through, for
 * the caller to report if unknown; no valid skill name holds these characters, so nothing is ambiguous.
 */
export function expandSkillNames(requested: string[], names: string[]): string[] {
  const result = new Set<string>();
  for (const item of requested) {
    if (!/[*?]/.test(item)) {
      result.add(item);
      continue;
    }
    const source = item.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const pattern = new RegExp(`^${source}$`);
    const matches = names.filter((n) => pattern.test(n));
    // "*" means every skill, and having none is not a mistake; a narrower pattern that finds nothing is.
    if (!matches.length && item !== "*") throw new SkillsymError("NO_SKILL_MATCHES", `No skill matches "${item}".`, { pattern: item });
    for (const m of matches) result.add(m);
  }
  return [...result].sort();
}

/**
 * Copy a skill folder (one containing SKILL.md) into the hub and record it in the manifest.
 * The skill's name is its folder name. Nothing changes if the name is taken or invalid.
 */
export async function addSkill(hub: Hub, sourcePath: string, options: AddSkillOptions = {}): Promise<SkillInfo> {
  const source = path.resolve(sourcePath);
  if (!(await isDirectory(source))) {
    throw new SkillsymError("SKILL_NOT_FOUND_AT_PATH", `Not a folder: ${source}`, { path: source });
  }
  if (!(await isFile(path.join(source, "SKILL.md")))) {
    throw new SkillsymError("MISSING_SKILL_MD", `No SKILL.md in ${source}`, { path: source });
  }
  const name = path.basename(source);
  if (!isValidSkillName(name)) {
    throw new SkillsymError(
      "INVALID_SKILL_NAME",
      `"${name}" is not a valid skill name (letters, digits, ".", "_", "-"; up to 64 characters).`,
      { name },
    );
  }

  return withLock(
    hub.lockPath,
    async () => {
      const manifest = await readManifest(hub.manifestPath);
      if (manifest.skills[name] || (await pathExists(path.join(hub.skillsDir, name)))) {
        throw new SkillsymError("SKILL_EXISTS", `A skill named "${name}" is already in the hub.`, { name });
      }
      return copyIntoHub(hub, name, source, options);
    },
    options.lock,
  );
}

/** A hub folder that holds a skill but is not in the manifest. */
export interface UnregisteredSkill {
  name: string;
  path: string;
  /** Set when the folder is not safe to register: SKILL.md names the skill differently than its folder. */
  reason?: "name-mismatch";
}

/** The `name:` in SKILL.md's frontmatter, if any. */
async function skillMdName(skillDir: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const front = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1];
  const value = front && /^name:[ \t]*(.*?)[ \t]*$/m.exec(front)?.[1];
  return value ? value.replace(/^(["'])(.*)\1$/, "$2") || undefined : undefined;
}

/**
 * Hub folders that look like skills but are not in the manifest. Loose files, dot and `tmp*` folders
 * (staging), folders without SKILL.md and invalid names are skipped: they are not finished skills.
 */
export async function listUnregisteredSkills(hub: Hub, manifest: Manifest): Promise<UnregisteredSkill[]> {
  let names: string[];
  try {
    names = (await fs.readdir(hub.skillsDir)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: UnregisteredSkill[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name.startsWith("tmp") || !isValidSkillName(name) || manifest.skills[name]) continue;
    const dir = path.join(hub.skillsDir, name);
    if (!(await isDirectory(dir)) || !(await isFile(path.join(dir, "SKILL.md")))) continue;
    const declared = await skillMdName(dir).catch(() => undefined);
    found.push({ name, path: dir, ...(declared && declared !== name ? { reason: "name-mismatch" as const } : {}) });
  }
  return found;
}

/**
 * Record a skill folder already in the hub in the manifest, as `add` does for a copy but without
 * copying. Callers hold the hub lock. Refuses a folder that is not a valid unregistered skill.
 */
export async function registerHubSkillLocked(
  hub: Hub,
  name: string,
  options: { profiles?: AgentProfile[]; git?: GitRunner } = {},
): Promise<SkillInfo> {
  const manifest = await readManifest(hub.manifestPath);
  const candidate = (await listUnregisteredSkills(hub, manifest)).find((u) => u.name === name);
  if (!candidate) throw new SkillsymError("SKILL_NOT_IN_HUB", `"${name}" is not an unregistered skill folder in the hub.`, { skill: name });
  if (candidate.reason === "name-mismatch") {
    throw new SkillsymError(
      "SKILL_NAME_MISMATCH",
      `Not registering "${name}": its SKILL.md names the skill differently than its folder. Rename the folder or fix the name in SKILL.md.`,
      { skill: name, path: candidate.path },
    );
  }
  const dest = candidate.path;
  const remote = await discoverSkillOrigin(name, dest, { hub, profiles: options.profiles, git: options.git });
  const upstreams = remote ? [] : await discoverSkillUpstreams(name, dest, { hub, profiles: options.profiles, git: options.git });
  manifest.skills[name] = {
    agents: [],
    mode: "link",
    scope: "user",
    // No `source`: the hub may itself be a git repo, and update would take it for the skill's origin.
    sourceHash: await hashSkillDir(dest),
    ...(remote ? { remote } : {}),
    ...(upstreams.length ? { upstreams } : {}),
  };
  await writeManifest(hub.manifestPath, manifest);
  return {
    name,
    path: dest,
    agents: [],
    mode: "link",
    scope: "user",
    ...(remote ? { remote } : {}),
    ...(upstreams.length ? { upstreams } : {}),
  };
}

/** Register an unregistered hub skill folder in place, under the hub lock. */
export async function registerHubSkill(
  hub: Hub,
  name: string,
  options: { profiles?: AgentProfile[]; git?: GitRunner; lock?: LockOptions } = {},
): Promise<SkillInfo> {
  return withLock(hub.lockPath, () => registerHubSkillLocked(hub, name, options), options.lock);
}

/**
 * Copy `source` into the hub as `name` and record it, with where it came from, in the manifest.
 * Callers hold the hub lock and have checked the name is free. A failed copy or manifest write
 * leaves the hub as it was.
 */
export async function copyIntoHub(
  hub: Hub,
  name: string,
  source: string,
  options: { profiles?: AgentProfile[]; git?: GitRunner; remote?: RemoteSkillInfo } = {},
): Promise<SkillInfo> {
  const dest = path.join(hub.skillsDir, name);
  // Stage the copy, then rename into place, so a failed copy never leaves a half skill in the hub.
  const staging = path.join(hub.tmpDir, `${name}.${randomBytes(6).toString("hex")}`);
  await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false });
  try {
    await renameWithRetry(staging, dest);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw err;
  }

  const discoveredRemote =
    options.remote ?? (await discoverSkillOrigin(name, dest, { sourceDir: source, hub, profiles: options.profiles, git: options.git }));
  const discoveredUpstreams =
    discoveredRemote ? [] : await discoverSkillUpstreams(name, dest, { hub, profiles: options.profiles, git: options.git });
  const manifest = await readManifest(hub.manifestPath);
  manifest.skills[name] = {
    agents: [],
    mode: "link",
    scope: "user",
    source,
    sourceHash: await hashSkillDir(dest),
    ...(discoveredRemote ? { remote: discoveredRemote } : {}),
    ...(discoveredUpstreams.length ? { upstreams: discoveredUpstreams } : {}),
  };
  try {
    await writeManifest(hub.manifestPath, manifest);
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  }
  return {
    name,
    path: dest,
    agents: [],
    mode: "link",
    scope: "user",
    ...(discoveredRemote ? { remote: discoveredRemote } : {}),
    ...(discoveredUpstreams.length ? { upstreams: discoveredUpstreams } : {}),
  };
}

/**
 * Atomically replace `<hub>/skills/<name>` with the contents of `source`, moving any existing hub
 * copy into `<hub>/backups/<stamp>/<backupLabel>/<name>` first and restoring it on rename failure.
 */
export async function replaceHubSkillFromSource(
  hub: Hub,
  name: string,
  source: string,
  backupLabel: string,
  stamp?: string,
): Promise<string | undefined> {
  const dest = path.join(hub.skillsDir, name);
  await fs.mkdir(hub.skillsDir, { recursive: true });
  await fs.mkdir(hub.tmpDir, { recursive: true });
  const staging = path.join(hub.tmpDir, `${name}.${randomBytes(6).toString("hex")}`);
  await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false });

  let backup: string | undefined;
  if (await pathExists(dest)) {
    backup = await moveToBackup(hub, dest, backupLabel, name, stamp);
  }
  try {
    await renameWithRetry(staging, dest);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
    if (backup && !(await pathExists(dest))) {
      await renameWithRetry(backup, dest).catch(() => {});
    }
    throw err;
  }
  return backup;
}

export async function listSkills(hub: Hub): Promise<SkillInfo[]> {
  const manifest = await readManifest(hub.manifestPath);
  return Object.keys(manifest.skills)
    .sort()
    .map((name) => {
      const entry = manifest.skills[name]!;
      return {
        name,
        path: path.join(hub.skillsDir, name),
        agents: [...entry.agents],
        mode: entry.mode,
        scope: entry.scope,
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.remote ? { remote: { ...entry.remote } } : {}),
        ...(entry.upstreams?.length ? { upstreams: entry.upstreams.map((u) => ({ ...u })) } : {}),
      };
    });
}
