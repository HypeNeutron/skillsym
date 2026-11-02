import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile, pathExists } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type SkillMode, type SkillScope } from "./manifest.js";

export interface SkillInfo {
  name: string;
  /** Real folder inside the hub. */
  path: string;
  agents: string[];
  mode: SkillMode;
  scope: SkillScope;
  /** Where the skill came from; for a --link skill, the library folder it links to. */
  source?: string;
}

export interface AddSkillOptions {
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
      return copyIntoHub(hub, name, source);
    },
    options.lock,
  );
}

/**
 * Copy `source` into the hub as `name` and record it, with where it came from, in the manifest.
 * Callers hold the hub lock and have checked the name is free. A failed copy or manifest write
 * leaves the hub as it was.
 */
export async function copyIntoHub(hub: Hub, name: string, source: string): Promise<SkillInfo> {
  const dest = path.join(hub.skillsDir, name);
  // Stage the copy, then rename into place, so a failed copy never leaves a half skill in the hub.
  const staging = path.join(hub.tmpDir, `${name}.${randomBytes(6).toString("hex")}`);
  await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false });
  try {
    await fs.rename(staging, dest);
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    throw err;
  }

  const manifest = await readManifest(hub.manifestPath);
  manifest.skills[name] = { agents: [], mode: "link", scope: "user", source, sourceHash: await hashSkillDir(dest) };
  try {
    await writeManifest(hub.manifestPath, manifest);
  } catch (err) {
    await fs.rm(dest, { recursive: true, force: true });
    throw err;
  }
  return { name, path: dest, agents: [], mode: "link", scope: "user" };
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
      };
    });
}
