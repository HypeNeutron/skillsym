import path from "node:path";
import type { Hub } from "./hub.js";
import type { StatusWarning } from "./status.js";

/** Folder names that cloud sync clients create; a hub inside one gets its links mangled. */
const CLOUD_FOLDERS: { provider: string; match: RegExp }[] = [
  { provider: "OneDrive", match: /^onedrive( - .+)?$/i },
  { provider: "Dropbox", match: /^dropbox( \(.+\))?$/i },
  { provider: "Google Drive", match: /^(google ?drive|my drive)$/i },
  { provider: "iCloud Drive", match: /^(icloud ?drive|mobile documents)$/i },
  { provider: "Box", match: /^box( sync)?$/i },
];

/** Environment variables sync clients set to their root folder (Windows OneDrive sets these). */
const CLOUD_ENV = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];

/**
 * The cloud sync service whose folder contains `p`, if any. Matches the roots the clients advertise
 * in the environment, and the folder names they create, so Desktop or Documents redirected into
 * OneDrive is caught as well.
 */
export function cloudSyncProvider(p: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const full = path.resolve(p);
  for (const key of CLOUD_ENV) {
    const root = env[key]?.trim();
    if (root && isInside(full, path.resolve(root))) return "OneDrive";
  }
  for (const segment of full.split(/[\\/]/)) {
    const hit = CLOUD_FOLDERS.find((c) => c.match.test(segment));
    if (hit) return hit.provider;
  }
  return null;
}

/** Warnings about where the hub lives, shown by status and before every command that writes. */
export function hubLocationWarnings(hub: Hub, env: NodeJS.ProcessEnv = process.env): StatusWarning[] {
  const provider = cloudSyncProvider(hub.home, env);
  if (!provider) return [];
  return [
    {
      code: "HUB_IN_CLOUD_FOLDER",
      message:
        `The hub (${hub.home}) is inside a ${provider} folder. Sync clients can turn links into copies or break them. ` +
        "Move the hub somewhere that is not synced and point SKILLSYM_HOME at it, then run `skillsym sync`.",
      path: hub.home,
    },
  ];
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
