import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** OS clutter that must not make two otherwise identical skills look different. */
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Content hash of a skill folder: every file's relative path (always "/"-separated) and bytes,
 * in sorted order. Links inside the folder are hashed by their target text, not followed.
 */
export async function hashSkillDir(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const rel of await walk(dir, "")) {
    const full = path.join(dir, ...rel.split("/"));
    const stat = await fs.lstat(full);
    hash.update(`${rel}\0`);
    if (stat.isSymbolicLink()) hash.update(`link:${await fs.readlink(full)}`);
    else hash.update(await fs.readFile(full));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function walk(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, ...prefix.split("/").filter(Boolean)), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}
