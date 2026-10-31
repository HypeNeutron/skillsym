import { promises as fs } from "node:fs";
import path from "node:path";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile, pathExists } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest } from "./manifest.js";
import { copyIntoHub, isValidSkillName, type SkillInfo } from "./skills.js";

/** Folders never searched for skills inside a library. */
const SKIP_DIRS = new Set(["node_modules"]);

export interface LibrarySkill {
  name: string;
  path: string;
}

/**
 * Every skill folder (one containing SKILL.md) under `root`, at any depth, so libraries grouped in
 * category folders work. A skill folder is not searched further; dotfolders (.git, …),
 * node_modules and links are skipped. If `root` itself has a SKILL.md, it is the only skill.
 */
export async function findLibrarySkills(root: string): Promise<LibrarySkill[]> {
  const found: LibrarySkill[] = [];
  async function walk(dir: string): Promise<void> {
    if (await isFile(path.join(dir, "SKILL.md"))) {
      found.push({ name: path.basename(dir), path: dir });
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Links are not followed: a library linking into itself must not loop.
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      await walk(path.join(dir, e.name));
    }
  }
  await walk(path.resolve(root));
  return found;
}

export type LibraryItemType = "add" | "skip";

export interface LibraryItem {
  name: string;
  path: string;
  type: LibraryItemType;
  reason?: string;
}

export interface LibraryPlan {
  library: string;
  items: LibraryItem[];
}

export interface LibraryAddResult extends LibraryPlan {
  added: SkillInfo[];
}

/** Decide what adding a library would do. Read-only. */
export async function planLibraryAdd(hub: Hub, libraryPath: string): Promise<LibraryPlan> {
  const library = path.resolve(libraryPath);
  if (!(await isDirectory(library))) {
    throw new SkillsymError("SKILL_NOT_FOUND_AT_PATH", `Not a folder: ${library}`, { path: library });
  }
  const skills = await findLibrarySkills(library);
  if (!skills.length) {
    throw new SkillsymError(
      "MISSING_SKILL_MD",
      `No skills found under ${library} (looked for folders containing SKILL.md, skipping dotfolders and node_modules).`,
      { path: library },
    );
  }
  const manifest = await readManifest(hub.manifestPath);
  const items: LibraryItem[] = [];
  for (const s of skills) {
    const twins = skills.filter((o) => o.name.toLowerCase() === s.name.toLowerCase());
    let reason: string | undefined;
    if (!isValidSkillName(s.name)) reason = `"${s.name}" is not a valid skill name; rename the folder (letters, digits, ".", "_", "-")`;
    else if (twins.length > 1) {
      reason = `the library has ${twins.length} skills named "${s.name}" (${twins.map((t) => path.relative(library, t.path)).join(", ")}); rename all but one`;
    } else if (manifest.skills[s.name] || (await pathExists(path.join(hub.skillsDir, s.name)))) {
      reason = `a skill named "${s.name}" is already in the hub; remove it first (skillsym remove ${s.name}) or rename the folder`;
    }
    items.push({ name: s.name, path: s.path, type: reason ? "skip" : "add", ...(reason ? { reason } : {}) });
  }
  return { library, items };
}

/**
 * Copy every skill in a library into the hub (the hub becomes the source of truth). The library
 * itself is never changed. Skills that cannot be added are reported and skipped; the rest are added.
 */
export async function addLibrary(hub: Hub, libraryPath: string, options: { lock?: LockOptions } = {}): Promise<LibraryAddResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const plan = await planLibraryAdd(hub, libraryPath);
      const added: SkillInfo[] = [];
      for (const item of plan.items) {
        if (item.type === "add") added.push(await copyIntoHub(hub, item.name, item.path));
      }
      return { ...plan, added };
    },
    options.lock,
  );
}
