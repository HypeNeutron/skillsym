import { promises as fs } from "node:fs";
import { SkillsymError } from "./errors.js";
import { writeFileAtomic } from "./fsutil.js";

export const STATE_VERSION = 1;

export type LinkKind = "junction" | "symlink";

/** One link skillsym created. Anything on disk that is not listed here is not ours to touch. */
export interface StateLink {
  /** Absolute path of the link inside an agent's skills folder. */
  path: string;
  /** Absolute path of the skill folder in the hub. */
  target: string;
  skill: string;
  kind: LinkKind;
  /** Content hash of the skill when the link was created. */
  hash: string;
  createdAt: string;
}

/** What skillsym has actually created (as opposed to the manifest, which is what the user wants). */
export interface State {
  version: number;
  links: StateLink[];
}

export async function readState(file: string): Promise<State> {
  let raw: string;
  try {
    raw = (await fs.readFile(file, "utf8")).replace(/^﻿/, "");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: STATE_VERSION, links: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillsymError("STATE_CORRUPT", `State file is not valid JSON: ${file}`, { file });
  }
  const obj = parsed as Partial<State>;
  if (typeof obj?.version !== "number" || !Array.isArray(obj.links)) {
    throw new SkillsymError("STATE_CORRUPT", `State file is malformed: ${file}`, { file });
  }
  if (obj.version !== STATE_VERSION) {
    throw new SkillsymError(
      "UNSUPPORTED_STATE_VERSION",
      `State version ${obj.version} is not supported by this skillsym (expects ${STATE_VERSION}). ` +
        "Upgrade skillsym; the file was left untouched.",
      { file, version: obj.version, supported: STATE_VERSION },
    );
  }
  return { version: obj.version, links: obj.links };
}

export async function writeState(file: string, state: State): Promise<void> {
  const links = [...state.links].sort((a, b) => a.path.localeCompare(b.path));
  await writeFileAtomic(file, JSON.stringify({ version: state.version, links }, null, 2) + "\n");
}

/** Paths are compared case-insensitively on Windows, where the filesystem is case-insensitive. */
export function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
