import { promises as fs } from "node:fs";
import path from "node:path";
import type { LinkKind } from "./state.js";

/**
 * Create a directory link at `linkPath` pointing to `target`.
 * Windows gets a junction, which needs neither admin rights nor Developer Mode (verified in
 * spike 01; symlinks failed there). Other platforms get a directory symlink.
 */
export async function createDirLink(target: string, linkPath: string): Promise<LinkKind> {
  if (process.platform === "win32") {
    await fs.symlink(path.resolve(target), linkPath, "junction");
    return "junction";
  }
  await fs.symlink(path.resolve(target), linkPath, "dir");
  return "symlink";
}

/** The absolute target of a link at `p`, or null if `p` is missing or not a link. */
export async function readLinkTarget(p: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(p);
    if (!stat.isSymbolicLink()) return null;
    const raw = await fs.readlink(p);
    return path.resolve(path.dirname(p), raw.replace(/^\\\\\?\\/, ""));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
