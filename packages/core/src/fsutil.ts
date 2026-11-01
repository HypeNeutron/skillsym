import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Write UTF-8 text with no BOM, atomically: write a sibling temp file, then rename over the target.
 * Codex refuses SKILL.md files that start with a BOM, so nothing skillsym writes may carry one.
 */
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, text.replace(/^﻿/, ""), { encoding: "utf8" });
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Windows refuses to replace a file while anything has it open (another process, antivirus, an indexer); that passes quickly. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy = process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!busy || attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25 + attempt * 10));
    }
  }
}

/**
 * True when an fs error means "nothing there". A path that goes through a file (e.g. README.txt/SKILL.md)
 * fails with ENOTDIR on macOS and Linux but ENOENT on Windows; both mean the same thing here.
 */
/**
 * Create `file` only if it does not exist, never overwriting one. It appears complete: another
 * process cannot read it half written. A hard link fails if the name is taken, which a rename would not.
 */
export async function writeFileIfAbsent(file: string, text: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(temp, text, "utf8");
  try {
    await fs.link(temp, file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    // A filesystem without hard links: an exclusive create is the next best thing.
    try {
      await fs.writeFile(file, text, { encoding: "utf8", flag: "wx" });
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code !== "EEXIST") throw fallback;
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}
