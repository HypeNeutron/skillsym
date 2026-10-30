import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureManifest } from "./manifest.js";

export interface Hub {
  /** Root of everything skillsym owns, e.g. ~/.skillsym or $SKILLSYM_HOME. */
  home: string;
  /** Where the real skill folders live; agent folders link here. */
  skillsDir: string;
  backupsDir: string;
  /** Scratch space for staging copies before they are renamed into place. */
  tmpDir: string;
  manifestPath: string;
  /** Record of every link skillsym created. */
  statePath: string;
  lockPath: string;
}

export interface ResolveHomeOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

export function resolveHubHome(options: ResolveHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = env.SKILLSYM_HOME?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(options.homedir ?? os.homedir(), ".skillsym");
}

export function hubPaths(home: string): Hub {
  return {
    home,
    skillsDir: path.join(home, "skills"),
    backupsDir: path.join(home, "backups"),
    tmpDir: path.join(home, ".tmp"),
    manifestPath: path.join(home, "manifest.json"),
    statePath: path.join(home, "state.json"),
    lockPath: path.join(home, ".lock"),
  };
}

/** Return the hub at `home`, creating its folders and an empty manifest on first use. */
export async function openHub(home: string = resolveHubHome()): Promise<Hub> {
  const hub = hubPaths(home);
  await fs.mkdir(hub.skillsDir, { recursive: true });
  await fs.mkdir(hub.backupsDir, { recursive: true });
  await fs.mkdir(hub.tmpDir, { recursive: true });
  await ensureManifest(hub.manifestPath);
  return hub;
}
