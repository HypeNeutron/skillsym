import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isMissing, pathExists, writeFileAtomic } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { assignInManifest, placeInHub, planImport, replaceWithLinks, type ImportItem, type ImportOptions } from "./import.js";
import { replaceHubVersion } from "./hub-version.js";
import { withLock } from "./lock.js";
import { readManifest } from "./manifest.js";
import { isValidSkillName } from "./skills.js";
import { samePath } from "./state.js";

export type ImportChoice =
  /** One version becomes the hub's; every other copy is backed up and replaced by a link to it. */
  | "primary"
  /** Every distinct version is kept as its own skill (e.g. research and research-codex). */
  | "keep-both"
  /** Write a merge with git-style conflict markers; finish with `import --continue`. */
  | "merge"
  /** Decide later; nothing changes. */
  | "skip";

/** One distinct version of a conflicting skill: an agent's copy, or the hub's. */
export interface ImportVersion {
  /** "hub", or the id of the first agent holding this version. */
  label: string;
  path: string;
  hash: string;
  /** Agents holding this version (empty for the hub's). */
  agents: string[];
}

export interface ImportDecision {
  name: string;
  choice: ImportChoice;
  /** For "primary": the path of the version to keep (an agent's copy, or the hub skill's folder). */
  primary?: string;
}

export interface ImportDecisionResult {
  name: string;
  choice: ImportChoice;
  ok: boolean;
  backups: string[];
  linked: string[];
  /** For "keep-both": the names given to the extra versions. */
  newSkills?: string[];
  /** For "merge": where to edit, and which files still have conflict markers. */
  mergeDir?: string;
  conflictedFiles?: string[];
  /** Set when the result was written into the user's library (a skill added with --link). */
  library?: string;
  /** For "merge": binary files that differ, and the extra versions to resolve. */
  binaryConflicts?: BinaryConflict[];
  error?: string;
}

/** A merge waiting for the user (stored in the hub while it is open). */
export interface PendingImport {
  version: 1;
  skill: string;
  mergeDir: string;
  /** Whether the hub already had this skill (its old version is backed up on continue). */
  inHub: boolean;
  sources: { path: string; agents: string[]; hash: string }[];
  /** Binary files that differed; --continue waits until every extra version is deleted. */
  binary?: BinaryConflict[];
  startedAt: string;
}

/** A binary file whose versions differ: `file` holds the `kept` version, `extras` the others. */
export interface BinaryConflict {
  file: string;
  kept: string;
  /** e.g. "diagram.png.codex"; paths relative to the merge folder. */
  extras: string[];
}

/** The distinct versions behind an import conflict: the hub's first (if any), then each differing copy. */
export async function importVersions(hub: Hub, item: ImportItem): Promise<ImportVersion[]> {
  const versions: ImportVersion[] = [];
  const hubDir = path.join(hub.skillsDir, item.name);
  const manifest = await readManifest(hub.manifestPath);
  if (manifest.skills[item.name] && (await isDirectory(hubDir))) {
    versions.push({ label: "hub", path: hubDir, hash: await hashSkillDir(hubDir), agents: [] });
  }
  for (const s of item.sources) {
    const same = versions.find((v) => v.hash === s.hash);
    if (same) same.agents.push(...s.agents);
    else versions.push({ label: s.agents[0] ?? "copy", path: s.path, hash: s.hash, agents: [...s.agents] });
  }
  return versions;
}

/**
 * Apply the user's decisions for import conflicts. Re-plans under the hub lock, so a decision only
 * applies if its conflict still exists. Only one merge may be open at a time.
 */
export async function resolveImportConflicts(hub: Hub, decisions: ImportDecision[], options: ImportOptions = {}): Promise<ImportDecisionResult[]> {
  const profiles = options.profiles ?? builtinAgents();
  return withLock(
    hub.lockPath,
    async () => {
      const plan = await planImport(hub, { profiles });
      const results: ImportDecisionResult[] = [];
      for (const d of decisions) {
        const result: ImportDecisionResult = { name: d.name, choice: d.choice, ok: true, backups: [], linked: [] };
        results.push(result);
        const item = plan.items.find((i) => i.name === d.name && i.type === "conflict");
        try {
          if (!item) throw new Error("no import conflict for this skill any more");
          if (d.choice === "skip") continue;
          const versions = await importVersions(hub, item);
          if (d.choice === "primary") await choosePrimary(hub, profiles, item, versions, d, result);
          else if (d.choice === "keep-both") await keepBoth(hub, profiles, item, versions, result);
          else await startMerge(hub, item, versions, result);
        } catch (err) {
          result.ok = false;
          result.error = (err as Error).message;
        }
      }
      return results;
    },
    options.lock,
  );
}

async function choosePrimary(
  hub: Hub,
  profiles: AgentProfile[],
  item: ImportItem,
  versions: ImportVersion[],
  d: ImportDecision,
  result: ImportDecisionResult,
): Promise<void> {
  const chosen = versions.find((v) => d.primary !== undefined && samePath(v.path, d.primary));
  if (!chosen) throw new Error(`choose which version to keep: ${versions.map((v) => v.path).join(", ")}`);
  if (chosen.label !== "hub") {
    if (versions[0]?.label === "hub") {
      // Writes into the user's library for a --link skill (backed up first).
      const replaced = await replaceHubVersion(hub, item.name, chosen.path);
      result.backups.push(...replaced.backups);
      if (replaced.library) result.library = replaced.library;
    } else await placeInHub(hub, item.name, chosen.path);
  }
  await assignInManifest(hub, item.name, item.sources.flatMap((s) => s.agents));
  await replaceWithLinks(hub, profiles, item.name, item.sources, result);
}

async function keepBoth(hub: Hub, profiles: AgentProfile[], item: ImportItem, versions: ImportVersion[], result: ImportDecisionResult): Promise<void> {
  const manifest = await readManifest(hub.manifestPath);
  const taken = new Set(Object.keys(manifest.skills));
  result.newSkills = [];
  // The hub's version (or else the first copy) keeps the name; every other version gets "<name>-<agent>".
  for (const [i, version] of versions.entries()) {
    let name = item.name;
    if (i > 0) {
      name = `${item.name}-${version.label}`;
      for (let n = 2; taken.has(name) || (await pathExists(path.join(hub.skillsDir, name))); n++) name = `${item.name}-${version.label}-${n}`;
      if (!isValidSkillName(name)) throw new Error(`cannot derive a valid name for the ${version.label} version`);
      taken.add(name);
      result.newSkills.push(name);
    }
    if (version.label !== "hub") await placeInHub(hub, name, version.path);
    const sources = item.sources.filter((s) => s.hash === version.hash);
    await assignInManifest(hub, name, sources.flatMap((s) => s.agents));
    await replaceWithLinks(hub, profiles, name, sources, result);
  }
}

async function startMerge(hub: Hub, item: ImportItem, versions: ImportVersion[], result: ImportDecisionResult): Promise<void> {
  if (await pathExists(hub.pendingImportPath)) {
    const pending = await readPendingImport(hub);
    throw new SkillsymError("IMPORT_PENDING", `finish or abort the open merge of "${pending?.skill}" first (skillsym import --continue / --abort)`);
  }
  const mergeDir = path.join(hub.home, "merge", item.name);
  await fs.rm(mergeDir, { recursive: true, force: true });
  await fs.mkdir(mergeDir, { recursive: true });
  const { conflicted, binary } = await writeMerge(mergeDir, versions);

  const pending: PendingImport = {
    version: 1,
    skill: item.name,
    mergeDir,
    inHub: versions[0]?.label === "hub",
    sources: item.sources.map((s) => ({ path: s.path, agents: s.agents, hash: s.hash })),
    binary,
    startedAt: new Date().toISOString(),
  };
  await writeFileAtomic(hub.pendingImportPath, JSON.stringify(pending, null, 2) + "\n");
  result.mergeDir = mergeDir;
  result.conflictedFiles = conflicted;
  result.binaryConflicts = binary;
}

/**
 * Two-way (or n-way) merge without a common base: files that are the same, or present in only one
 * version, are copied; text files that differ get git-style markers around the differing lines.
 * Binary files that differ are written as the first version plus "<file>.<label>" copies; the user
 * keeps one and deletes the rest, and --continue refuses until they have.
 */
async function writeMerge(mergeDir: string, versions: ImportVersion[]): Promise<{ conflicted: string[]; binary: BinaryConflict[] }> {
  const files = new Set<string>();
  for (const v of versions) for (const f of await listFiles(v.path, "")) files.add(f);
  const conflicted: string[] = [];
  const binary: BinaryConflict[] = [];

  for (const rel of [...files].sort()) {
    const out = path.join(mergeDir, ...rel.split("/"));
    await fs.mkdir(path.dirname(out), { recursive: true });
    const contents = await Promise.all(versions.map(async (v) => ({ v, bytes: await readOrNull(path.join(v.path, ...rel.split("/"))) })));
    const present = contents.filter((c): c is { v: ImportVersion; bytes: Buffer } => c.bytes !== null);
    const isText = (b: Buffer) => !b.subarray(0, 8192).includes(0);
    const same = (a: Buffer, b: Buffer) => a.equals(b) || (isText(a) && isText(b) && toText(a) === toText(b));
    const distinct = present.filter((c, i) => present.findIndex((o) => same(o.bytes, c.bytes)) === i);
    if (distinct.length === 1 && present.length === versions.length) {
      await fs.writeFile(out, distinct[0]!.bytes);
      continue;
    }
    if (distinct.length === 1) {
      // Only some versions have this file and they agree: keep it (a merge is a union).
      await fs.writeFile(out, distinct[0]!.bytes);
      continue;
    }
    conflicted.push(rel);
    if (distinct.some((c) => c.bytes.subarray(0, 8192).includes(0))) {
      await fs.writeFile(out, distinct[0]!.bytes);
      const extras: string[] = [];
      for (const c of distinct.slice(1)) {
        await fs.writeFile(`${out}.${c.v.label}`, c.bytes);
        extras.push(`${rel}.${c.v.label}`);
      }
      binary.push({ file: rel, kept: distinct[0]!.v.label, extras });
      continue;
    }
    await fs.writeFile(out, markConflict(contents.map((c) => ({ label: c.v.label, text: c.bytes === null ? null : toText(c.bytes) }))));
  }
  return { conflicted, binary };
}

/** Keep common leading/trailing lines; wrap the differing middle of each version in markers. */
function markConflict(sides: { label: string; text: string | null }[]): string {
  const lines = sides.map((s) => (s.text === null ? null : s.text.split("\n")));
  const present = lines.filter((l): l is string[] => l !== null);
  let head = 0;
  while (present.every((l) => head < l.length && l[head] === present[0]![head])) head++;
  let tail = 0;
  while (present.every((l) => tail < l.length - head && l[l.length - 1 - tail] === present[0]![present[0]!.length - 1 - tail])) tail++;

  const out = present[0]!.slice(0, head);
  sides.forEach((s, i) => {
    const l = lines[i];
    out.push(i === 0 ? `<<<<<<< ${s.label}${l === null ? " (file missing)" : ""}` : `======= ${s.label}${l === null ? " (file missing)" : ""}`);
    if (l) out.push(...l.slice(head, l.length - tail));
  });
  out.push(">>>>>>>");
  out.push(...present[0]!.slice(present[0]!.length - tail));
  return out.join("\n");
}

const MARKER = /^(<<<<<<< |=======( |$)|>>>>>>>$)/m;

export async function readPendingImport(hub: Hub): Promise<PendingImport | null> {
  try {
    return JSON.parse(await fs.readFile(hub.pendingImportPath, "utf8")) as PendingImport;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Finish an open merge: refuse while conflict markers remain or if an agent's copy changed since the
 * merge started; otherwise the merged folder becomes the hub version (the old one is backed up)
 * and every copy is backed up and replaced by a link.
 */
export async function continueImport(hub: Hub, options: ImportOptions = {}): Promise<ImportDecisionResult> {
  const profiles = options.profiles ?? builtinAgents();
  return withLock(
    hub.lockPath,
    async () => {
      const pending = await readPendingImport(hub);
      if (!pending) throw new SkillsymError("NO_PENDING_IMPORT", "There is no merge to continue. Start one with `skillsym import`.");
      const unresolved: string[] = [];
      for (const rel of await listFiles(pending.mergeDir, "")) {
        const bytes = await fs.readFile(path.join(pending.mergeDir, ...rel.split("/")));
        if (!bytes.subarray(0, 8192).includes(0) && MARKER.test(toText(bytes))) unresolved.push(rel);
      }
      const leftovers: string[] = [];
      for (const b of pending.binary ?? []) {
        for (const extra of b.extras) if (await pathExists(path.join(pending.mergeDir, ...extra.split("/")))) leftovers.push(extra);
      }
      if (unresolved.length || leftovers.length) {
        const problems: string[] = [];
        if (unresolved.length) problems.push(`conflict markers remain in ${unresolved.join(", ")} — edit each file so only the lines you want are left`);
        if (leftovers.length) {
          problems.push(
            `extra versions of binary files remain: ${leftovers.join(", ")} — for each, keep the one you want under the original name and delete the other`,
          );
        }
        throw new SkillsymError(
          "MERGE_UNRESOLVED",
          `The merge of "${pending.skill}" is not finished (${pending.mergeDir}): ${problems.join("; ")}. ` +
            "Then run `skillsym import --continue` again, or `skillsym import --abort` to drop the merge (nothing has been changed yet).",
          { files: unresolved, binaryLeftovers: leftovers, mergeDir: pending.mergeDir },
        );
      }
      for (const s of pending.sources) {
        if (!(await isDirectory(s.path)) || (await hashSkillDir(s.path)) !== s.hash) {
          throw new SkillsymError(
            "IMPORT_SOURCE_CHANGED",
            `${s.path} changed after the merge started, so finishing would overwrite that change. ` +
              "Run `skillsym import --abort`, then `skillsym import` to start again with the new version.",
            { path: s.path },
          );
        }
      }

      const result: ImportDecisionResult = { name: pending.skill, choice: "merge", ok: true, backups: [], linked: [] };
      const hubDir = path.join(hub.skillsDir, pending.skill);
      if (pending.inHub && (await isDirectory(hubDir))) {
        const replaced = await replaceHubVersion(hub, pending.skill, pending.mergeDir);
        result.backups.push(...replaced.backups);
        if (replaced.library) result.library = replaced.library;
      } else await placeInHub(hub, pending.skill, pending.mergeDir);
      await assignInManifest(hub, pending.skill, pending.sources.flatMap((s) => s.agents));
      await replaceWithLinks(hub, profiles, pending.skill, pending.sources, result);
      await fs.rm(pending.mergeDir, { recursive: true, force: true });
      await fs.rm(hub.pendingImportPath, { force: true });
      return result;
    },
    options.lock,
  );
}

/** Drop an open merge. Agents' copies were never touched, so nothing else needs restoring. */
export async function abortImport(hub: Hub, options: ImportOptions = {}): Promise<{ skill: string }> {
  return withLock(
    hub.lockPath,
    async () => {
      const pending = await readPendingImport(hub);
      if (!pending) throw new SkillsymError("NO_PENDING_IMPORT", "There is no merge to abort; nothing to do.");
      await fs.rm(pending.mergeDir, { recursive: true, force: true });
      await fs.rm(hub.pendingImportPath, { force: true });
      return { skill: pending.skill };
    },
    options.lock,
  );
}

async function listFiles(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, rel)));
    else out.push(rel);
  }
  return out;
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** UTF-8 text with any BOM dropped and CRLF normalized, so line comparison ignores those. */
function toText(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}
