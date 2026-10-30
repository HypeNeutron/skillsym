import { promises as fs } from "node:fs";
import { SkillsymError } from "./errors.js";
import { writeFileAtomic } from "./fsutil.js";

export const MANIFEST_VERSION = 1;

export type SkillMode = "link" | "copy";
export type SkillScope = "user" | "project";

export interface ManifestSkill {
  /** Agent ids this skill is assigned to. */
  agents: string[];
  /** Only "link" is implemented in v0.1; "copy" is reserved. */
  mode: SkillMode;
  /** Only "user" is implemented in v0.1; "project" is reserved for v0.2. */
  scope: SkillScope;
}

/** The user's desired state. */
export interface Manifest {
  version: number;
  skills: Record<string, ManifestSkill>;
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, skills: {} };
}

/** Create the manifest only if it does not exist yet; never touch an existing one. */
export async function ensureManifest(file: string): Promise<void> {
  try {
    await fs.writeFile(file, serialize(emptyManifest()), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Read and validate the manifest. A newer or unknown version is an error, never a reason to
 * reset the file: the user's assignments must survive a downgrade.
 */
export async function readManifest(file: string): Promise<Manifest> {
  const raw = (await fs.readFile(file, "utf8")).replace(/^﻿/, "");
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
      mode: entry.mode === "copy" ? "copy" : "link",
      scope: entry.scope === "project" ? "project" : "user",
    };
  }
  return { version: parsed.version, skills };
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(file, serialize(manifest));
}

function serialize(manifest: Manifest): string {
  const sorted: Manifest = {
    version: manifest.version,
    skills: Object.fromEntries(Object.keys(manifest.skills).sort().map((k) => [k, manifest.skills[k]!])),
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
