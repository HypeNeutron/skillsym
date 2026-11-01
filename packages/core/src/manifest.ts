import { promises as fs } from "node:fs";
import { SkillsymError } from "./errors.js";
import { writeFileAtomic, writeFileIfAbsent } from "./fsutil.js";

export const MANIFEST_VERSION = 1;

/**
 * How a hub skill is stored: "link" = the hub holds the real folder (agents link to it);
 * "source-link" = the hub entry is itself a link to a folder in the user's library, which stays the
 * source of truth; "copy" is reserved.
 */
export type SkillMode = "link" | "copy" | "source-link";
export type SkillScope = "user" | "project";

export interface ManifestSkill {
  /** Agent ids this skill is assigned to. */
  agents: string[];
  mode: SkillMode;
  /** Only "user" is implemented in v0.1; "project" is reserved for v0.2. */
  scope: SkillScope;
  /** Where the skill came from when it was added (a skill folder, possibly inside a library). */
  source?: string;
  /** Content hash of the skill at `source` when it was added. */
  sourceHash?: string;
}

/** The user's desired state. */
export interface Manifest {
  version: number;
  skills: Record<string, ManifestSkill>;
  /** Library folders added with `add --link`; checked for new and missing skills. */
  libraries?: string[];
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, skills: {} };
}

/** Create the manifest only if it does not exist yet; never touch an existing one. */
export async function ensureManifest(file: string): Promise<void> {
  await writeFileIfAbsent(file, serialize(emptyManifest()));
}

/**
 * Read and validate the manifest. A missing file reads as empty (the hub was never created).
 * A newer or unknown version is an error, never a reason to reset the file: the user's
 * assignments must survive a downgrade.
 */
export async function readManifest(file: string): Promise<Manifest> {
  let raw: string;
  try {
    raw = (await fs.readFile(file, "utf8")).replace(/^﻿/, "");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillsymError("MANIFEST_CORRUPT", `Manifest is not valid JSON: ${file}`, { file });
  }
  if (!isObject(parsed) || typeof parsed.version !== "number") {
    throw new SkillsymError("MANIFEST_CORRUPT", `Manifest has no version field: ${file}`, { file });
  }
  if (parsed.version !== MANIFEST_VERSION) {
    throw new SkillsymError(
      "UNSUPPORTED_MANIFEST_VERSION",
      `Manifest version ${parsed.version} is not supported by this skillsym (expects ${MANIFEST_VERSION}). ` +
        "Upgrade skillsym; the file was left untouched.",
      { file, version: parsed.version, supported: MANIFEST_VERSION },
    );
  }
  if (!isObject(parsed.skills)) {
    throw new SkillsymError("MANIFEST_CORRUPT", `Manifest has no skills object: ${file}`, { file });
  }
  const skills: Record<string, ManifestSkill> = {};
  for (const [name, entry] of Object.entries(parsed.skills)) {
    if (!isObject(entry) || !Array.isArray(entry.agents)) {
      throw new SkillsymError("MANIFEST_CORRUPT", `Manifest entry for "${name}" is malformed: ${file}`, { file, skill: name });
    }
    skills[name] = {
      agents: entry.agents.filter((a): a is string => typeof a === "string"),
      mode: entry.mode === "copy" || entry.mode === "source-link" ? entry.mode : "link",
      scope: entry.scope === "project" ? "project" : "user",
      ...(typeof entry.source === "string" ? { source: entry.source } : {}),
      ...(typeof entry.sourceHash === "string" ? { sourceHash: entry.sourceHash } : {}),
    };
  }
  const libraries = Array.isArray(parsed.libraries) ? parsed.libraries.filter((l): l is string => typeof l === "string") : [];
  return { version: parsed.version, skills, ...(libraries.length ? { libraries } : {}) };
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(file, serialize(manifest));
}

function serialize(manifest: Manifest): string {
  const sorted: Manifest = {
    version: manifest.version,
    skills: Object.fromEntries(Object.keys(manifest.skills).sort().map((k) => [k, manifest.skills[k]!])),
    ...(manifest.libraries?.length ? { libraries: [...manifest.libraries] } : {}),
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
