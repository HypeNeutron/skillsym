import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** OS clutter that must not make two otherwise identical skills look different. */
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/**
 * Content hash of a skill folder, stable across Windows, macOS and Linux.
 *
 * Rules:
 * - Every file is identified by its path relative to the skill folder, always "/"-separated,
 *   and files are hashed in sorted path order.
 * - OS clutter files (.DS_Store, Thumbs.db, desktop.ini) are skipped. Other dotfiles count.
 * - Text files (no NUL byte in the first 8 KiB) are normalized before hashing: a leading UTF-8
 *   BOM is dropped and CRLF becomes LF, so a git checkout with autocrlf or an editor that adds a
 *   BOM does not count as a content change. (A BOM still matters to Codex; that is reported as a
 *   separate warning, not as drift.)
 * - Binary files are hashed byte for byte.
 * - Links inside the folder are hashed by their target text, not followed.
 */
export async function hashSkillDir(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const rel of await walk(dir, "")) {
    const full = path.join(dir, ...rel.split("/"));
    const stat = await fs.lstat(full);
    hash.update(`${rel}\0`);
    if (stat.isSymbolicLink()) hash.update(`link:${await fs.readlink(full)}`);
    else hash.update(normalize(await fs.readFile(full)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function hasUtf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function normalize(bytes: Buffer): Buffer {
  if (bytes.subarray(0, 8192).includes(0)) return bytes;
  const body = hasUtf8Bom(bytes) ? bytes.subarray(3) : bytes;
  return Buffer.from(body.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
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
