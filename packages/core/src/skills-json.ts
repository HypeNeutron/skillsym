import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentDelivery, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isMissing, writeFileAtomic } from "./fsutil.js";
import type { Hub } from "./hub.js";
import type { Manifest } from "./manifest.js";
import { readState, samePath, writeState, type State, type StateManifest } from "./state.js";

export interface SkillsJsonEntry {
  path: string;
  include_only?: string[];
  exclude?: string[];
}

export interface DesiredSkillsJson {
  entries: SkillsJsonEntry[];
  /** Skill names included in `entries` (excluding `--link` skills whose source folder is missing). */
  includedSkills: string[];
  /** `--link` skills assigned to this agent whose library source folder is missing. */
  missingSourceSkills: string[];
}

export interface TargetSkillsJson {
  exists: boolean;
  rawObj: Record<string, unknown>;
}

export interface GeneratedFileState {
  exists: boolean;
  text: string;
  hash: string;
}

export type SkillsJsonWriteOutcome =
  | { ok: true; changed: boolean; generatedPath: string; skillsJsonPath: string; hash: string; includedSkills: string[] }
  | { ok: false; outcome: "blocked" | "failed"; reason: string; generatedPath: string; skillsJsonPath: string };

/** Path to the hub-managed generated file for a `skills-json` agent, e.g. `<hub>/antigravity-skills.json`. */
export function generatedManifestPath(hub: Hub, agentId: string): string {
  return path.join(hub.home, `${agentId}-skills.json`);
}

/** Antigravity's skills.json expects forward slashes across platforms. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function hashText(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Group an agent's assigned skills by their real parent folder with `include_only`:
 * - Standard hub skills share one entry pointing to `<hub>/skills`.
 * - `--link` skills group by their real library parent folder so Antigravity never walks a hub junction.
 */
export async function computeSkillsJsonEntries(hub: Hub, manifest: Manifest, agentId: string): Promise<DesiredSkillsJson> {
  const byDir = new Map<string, { path: string; include: Set<string> }>();
  const includedSkills: string[] = [];
  const missingSourceSkills: string[] = [];

  const addSkill = (dir: string, folderName: string) => {
    const posix = toPosixPath(path.resolve(dir));
    const key = process.platform === "win32" ? posix.toLowerCase() : posix;
    let group = byDir.get(key);
    if (!group) {
      group = { path: posix, include: new Set<string>() };
      byDir.set(key, group);
    }
    group.include.add(folderName);
  };

  for (const name of Object.keys(manifest.skills).sort()) {
    const entry = manifest.skills[name]!;
    if (!entry.agents.includes(agentId)) continue;
    if (entry.mode === "source-link") {
      if (!entry.source || !(await isDirectory(entry.source))) {
        missingSourceSkills.push(name);
        continue;
      }
      addSkill(path.dirname(entry.source), path.basename(entry.source));
      includedSkills.push(name);
    } else {
      addSkill(hub.skillsDir, name);
      includedSkills.push(name);
    }
  }

  const hubPosix = toPosixPath(path.resolve(hub.skillsDir));
  const entries: SkillsJsonEntry[] = [...byDir.values()]
    .sort((a, b) => {
      if (samePath(a.path, hubPosix)) return -1;
      if (samePath(b.path, hubPosix)) return 1;
      return a.path.localeCompare(b.path);
    })
    .map((g) => ({
      path: g.path,
      include_only: [...g.include].sort(),
    }));

  return { entries, includedSkills, missingSourceSkills };
}

export function serializeSkillsJson(entries: SkillsJsonEntry[]): string {
  return JSON.stringify({ entries }, null, 2) + "\n";
}

export async function readTargetSkillsJson(file: string): Promise<TargetSkillsJson> {
  let raw: string;
  try {
    raw = (await fs.readFile(file, "utf8")).replace(/^\ufeff/, "");
  } catch (err) {
    if (isMissing(err)) return { exists: false, rawObj: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillsymError("SKILLS_JSON_INVALID", `skills.json is not valid JSON: ${file}`, { file });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillsymError("SKILLS_JSON_INVALID", `skills.json must be a JSON object: ${file}`, { file });
  }
  return { exists: true, rawObj: parsed as Record<string, unknown> };
}

export async function readGeneratedFile(file: string): Promise<GeneratedFileState> {
  try {
    const text = (await fs.readFile(file, "utf8")).replace(/^\ufeff/, "");
    return { exists: true, text, hash: hashText(text) };
  } catch (err) {
    if (isMissing(err)) return { exists: false, text: "", hash: "" };
    throw err;
  }
}

function matchesInheritPath(rawPath: unknown, skillsJsonPath: string, generatedPath: string): boolean {
  if (typeof rawPath !== "string" || !rawPath.trim()) return false;
  const resolved = path.resolve(path.dirname(skillsJsonPath), rawPath);
  return samePath(resolved, generatedPath) || samePath(path.resolve(rawPath), generatedPath);
}

export function hasInheritsRef(rawObj: Record<string, unknown>, skillsJsonPath: string, generatedPath: string): boolean {
  if (!Array.isArray(rawObj.inherits)) return false;
  return rawObj.inherits.some((item) => typeof item === "object" && item !== null && matchesInheritPath((item as Record<string, unknown>).path, skillsJsonPath, generatedPath));
}

export function upsertInheritsRef(rawObj: Record<string, unknown>, skillsJsonPath: string, generatedPath: string): { changed: boolean; obj: Record<string, unknown> } {
  if (hasInheritsRef(rawObj, skillsJsonPath, generatedPath)) return { changed: false, obj: rawObj };
  const existing = Array.isArray(rawObj.inherits) ? [...rawObj.inherits] : [];
  const next: Record<string, unknown> = {
    ...rawObj,
    inherits: [...existing, { path: toPosixPath(path.resolve(generatedPath)) }],
    ...(rawObj.entries === undefined ? { entries: [] } : {}),
  };
  return { changed: true, obj: next };
}

export function removeInheritsRef(rawObj: Record<string, unknown>, skillsJsonPath: string, generatedPath: string): { changed: boolean; obj: Record<string, unknown> } {
  if (!Array.isArray(rawObj.inherits)) return { changed: false, obj: rawObj };
  const kept = rawObj.inherits.filter(
    (item) => !(typeof item === "object" && item !== null && matchesInheritPath((item as Record<string, unknown>).path, skillsJsonPath, generatedPath)),
  );
  if (kept.length === rawObj.inherits.length) return { changed: false, obj: rawObj };
  const next = { ...rawObj };
  if (kept.length) next.inherits = kept;
  else delete next.inherits;
  return { changed: true, obj: next };
}

export function findStateManifest(state: State, agentId: string): StateManifest | undefined {
  return (state.manifests ?? []).find((m) => m.agent === agentId);
}

export function forgetStateManifest(state: State, agentId: string): void {
  state.manifests = (state.manifests ?? []).filter((m) => m.agent !== agentId);
}

export function recordStateManifest(state: State, entry: StateManifest): void {
  forgetStateManifest(state, entry.agent);
  state.manifests = [...(state.manifests ?? []), entry];
}

export interface ApplySkillsJsonOptions {
  forceOverwrite?: boolean;
  dryRun?: boolean;
}

/**
 * Synchronize `<hub>/<agent>-skills.json`, the `inherits` reference in `agent.skillsJsonPath`,
 * and `state.manifests` from the given manifest. Preserves all other fields in `skills.json`.
 */
export async function applySkillsJsonDelivery(
  hub: Hub,
  agent: AgentProfile,
  manifest: Manifest,
  state: State,
  options: ApplySkillsJsonOptions = {},
): Promise<SkillsJsonWriteOutcome> {
  if (!agent.skillsJsonPath) {
    return {
      ok: false,
      outcome: "failed",
      reason: `Agent "${agent.id}" uses skills-json delivery but has no skillsJsonPath configured.`,
      generatedPath: generatedManifestPath(hub, agent.id),
      skillsJsonPath: "",
    };
  }
  const skillsJsonPath = agent.skillsJsonPath;
  const generatedPath = generatedManifestPath(hub, agent.id);
  const owned = findStateManifest(state, agent.id);

  try {
    const onDisk = await readGeneratedFile(generatedPath);
    if (!options.forceOverwrite && onDisk.exists && (!owned || onDisk.hash !== owned.generatedHash)) {
      return {
        ok: false,
        outcome: "blocked",
        reason: `${generatedPath} was modified outside skillsym; run \`skillsym status\` or \`skillsym sync\` to resolve it`,
        generatedPath,
        skillsJsonPath,
      };
    }

    const target = await readTargetSkillsJson(skillsJsonPath);
    const desired = await computeSkillsJsonEntries(hub, manifest, agent.id);

    if (desired.includedSkills.length === 0) {
      const removed = removeInheritsRef(target.rawObj, skillsJsonPath, generatedPath);
      const changed = onDisk.exists || removed.changed || owned !== undefined;
      if (!options.dryRun) {
        if (target.exists && removed.changed) {
          await writeFileAtomic(skillsJsonPath, JSON.stringify(removed.obj, null, 2) + "\n");
        }
        if (onDisk.exists) await fs.rm(generatedPath, { force: true });
        forgetStateManifest(state, agent.id);
      }
      return { ok: true, changed, generatedPath, skillsJsonPath, hash: "", includedSkills: [] };
    }

    const desiredText = serializeSkillsJson(desired.entries);
    const desiredHash = hashText(desiredText);
    const upserted = upsertInheritsRef(target.rawObj, skillsJsonPath, generatedPath);
    const needsGeneratedWrite = !onDisk.exists || onDisk.hash !== desiredHash;
    const needsTargetWrite = !target.exists || upserted.changed;
    const needsStateWrite =
      !owned ||
      owned.generatedHash !== desiredHash ||
      !samePath(owned.skillsJsonPath, skillsJsonPath) ||
      !samePath(owned.generatedPath, generatedPath) ||
      owned.skills.join("\0") !== desired.includedSkills.join("\0");
    const changed = needsGeneratedWrite || needsTargetWrite || needsStateWrite;

    if (!options.dryRun) {
      if (needsGeneratedWrite) {
        await fs.mkdir(path.dirname(generatedPath), { recursive: true });
        await writeFileAtomic(generatedPath, desiredText);
      }
      if (needsTargetWrite) {
        await fs.mkdir(path.dirname(skillsJsonPath), { recursive: true });
        await writeFileAtomic(skillsJsonPath, JSON.stringify(upserted.obj, null, 2) + "\n");
      }
      if (needsStateWrite) {
        recordStateManifest(state, {
          agent: agent.id,
          skillsJsonPath,
          generatedPath,
          generatedHash: desiredHash,
          skills: desired.includedSkills,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    return { ok: true, changed, generatedPath, skillsJsonPath, hash: desiredHash, includedSkills: desired.includedSkills };
  } catch (err) {
    return {
      ok: false,
      outcome: "failed",
      reason: (err as Error).message,
      generatedPath,
      skillsJsonPath,
    };
  }
}

/**
 * Refresh every `skills-json` agent whose assignments or state.manifests record need updating.
 * When `existingState` is omitted, reads and writes `hub.statePath` only if something changed.
 */
export async function refreshSkillsJsonManifests(
  hub: Hub,
  profiles: AgentProfile[],
  manifest: Manifest,
  existingState?: State,
  options: ApplySkillsJsonOptions = {},
): Promise<boolean> {
  const state = existingState ?? (await readState(hub.statePath));
  let changed = false;
  for (const agent of profiles) {
    if (agentDelivery(agent) !== "skills-json" || !agent.skillsJsonPath) continue;
    const assigned = Object.values(manifest.skills).some((e) => e.agents.includes(agent.id));
    const owned = findStateManifest(state, agent.id);
    if (!assigned && !owned) continue;
    const applied = await applySkillsJsonDelivery(hub, agent, manifest, state, options);
    if (applied.ok && applied.changed) changed = true;
  }
  if (!existingState && changed && !options.dryRun) await writeState(hub.statePath, state);
  return changed;
}
