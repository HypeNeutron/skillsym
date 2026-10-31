import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinAgents, planLinkGroups, type AgentProfile } from "./agents.js";
import { moveToBackup } from "./backup.js";
import { isDirectory, isFile } from "./fsutil.js";
import { hashSkillDir, hasUtf8Bom } from "./hash.js";
import type { Hub } from "./hub.js";
import { createDirLink, readLinkTarget } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest } from "./manifest.js";
import { isValidSkillName } from "./skills.js";
import { readState, samePath, writeState } from "./state.js";
import { scanStatus } from "./status.js";
import { recordStateLink } from "./sync.js";

export interface ImportSource {
  /** The skill folder inside an agent's skills folder. */
  path: string;
  /** Agents whose skills folder holds it. */
  agents: string[];
  hash: string;
  /** SKILL.md starts with a UTF-8 BOM (Codex will not load it). */
  bom: boolean;
}

export type ImportItemType =
  /** New to the hub; every copy found is identical. */
  | "import"
  /** Already in the hub with identical content; the copies are replaced by links. */
  | "link-existing"
  /** Copies differ from each other or from the hub; needs a decision (see `import` conflicts). */
  | "conflict"
  /** Cannot be imported (invalid name, or another tool's link). */
  | "skip";

export interface ImportItem {
  name: string;
  type: ImportItemType;
  sources: ImportSource[];
  reason?: string;
}

export interface ImportPlan {
  items: ImportItem[];
}

export interface ImportItemResult extends ImportItem {
  ok: boolean;
  /** Where each original folder was moved before being replaced by a link. */
  backups: string[];
  /** Link paths created. */
  linked: string[];
  error?: string;
}

export interface ImportResult {
  items: ImportItemResult[];
}

export interface ImportOptions {
  profiles?: AgentProfile[];
  lock?: LockOptions;
}

/**
 * Find skill folders in agents' skills folders that skillsym does not manage yet, and decide what
 * import would do with each. Read-only.
 */
export async function planImport(hub: Hub, options: ImportOptions = {}): Promise<ImportPlan> {
  const profiles = options.profiles ?? builtinAgents();
  const report = await scanStatus(hub, { profiles });
  const manifest = await readManifest(hub.manifestPath);

  const byName = new Map<string, ImportSource[]>();
  const items: ImportItem[] = [];
  // Real skill folders sitting at a path the manifest assigns (status "blocked") are candidates too:
  // that is what an interrupted import leaves behind, and what status tells the user to import.
  const candidates = [
    ...report.unmanaged,
    ...(await Promise.all(
      report.entries
        .filter((e) => e.status === "blocked" && e.linkTarget === undefined)
        .map(async (e) => ((await isDirectory(e.path)) && (await isFile(path.join(e.path, "SKILL.md"))) ? { name: e.skill, path: e.path, agents: e.agents, isLink: false } : null)),
    )).filter((c): c is NonNullable<typeof c> => c !== null),
  ];
  for (const u of candidates) {
    if (u.isLink) {
      items.push({
        name: u.name,
        type: "skip",
        sources: [],
        reason: `${u.path} is a link created by another tool; skillsym leaves it alone`,
      });
      continue;
    }
    const skillMd = await fs.readFile(path.join(u.path, "SKILL.md"));
    const source: ImportSource = { path: u.path, agents: u.agents, hash: await hashSkillDir(u.path), bom: hasUtf8Bom(skillMd) };
    byName.set(u.name, [...(byName.get(u.name) ?? []), source]);
  }

  for (const [name, sources] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isValidSkillName(name)) {
      items.push({ name, type: "skip", sources, reason: `"${name}" is not a valid skill name; rename the folder first` });
      continue;
    }
    const hashes = new Set(sources.map((s) => s.hash));
    const inHub = Boolean(manifest.skills[name]) && (await isDirectory(path.join(hub.skillsDir, name)));
    if (inHub) hashes.add(await hashSkillDir(path.join(hub.skillsDir, name)));
    if (hashes.size > 1) {
      items.push({
        name,
        type: "conflict",
        sources,
        reason: inHub ? "differs from the hub's version" : "the copies in different agents differ",
      });
    } else {
      items.push({ name, type: inHub ? "link-existing" : "import", sources });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items };
}

/**
 * Bring unmanaged skills into the hub: copy into the hub, back up each original folder, and put a
 * link in its place. Conflicts and skips are reported and left untouched. Each skill is recorded in
 * the manifest and state as soon as it is done, so an interrupted import can simply be run again.
 */
export async function importSkills(hub: Hub, options: ImportOptions = {}): Promise<ImportResult> {
  const profiles = options.profiles ?? builtinAgents();
  return withLock(
    hub.lockPath,
    async () => {
      const plan = await planImport(hub, { profiles });
      const results: ImportItemResult[] = [];
      for (const item of plan.items) {
        const result: ImportItemResult = { ...item, ok: true, backups: [], linked: [] };
        results.push(result);
        if (item.type !== "import" && item.type !== "link-existing") continue;
        try {
          await importOne(hub, profiles, item, result);
        } catch (err) {
          result.ok = false;
          result.error = (err as Error).message;
        }
      }
      return { items: results };
    },
    options.lock,
  );
}

async function importOne(hub: Hub, profiles: AgentProfile[], item: ImportItem, result: ImportItemResult): Promise<void> {
  const target = path.join(hub.skillsDir, item.name);
  const manifest = await readManifest(hub.manifestPath);
  const state = await readState(hub.statePath);

  if (item.type === "import") {
    // Stage then rename, so the hub never holds half a skill.
    const staging = path.join(hub.tmpDir, `${item.name}.${randomBytes(6).toString("hex")}`);
    await fs.cp(item.sources[0]!.path, staging, { recursive: true, errorOnExist: true });
    await fs.rename(staging, target);
    manifest.skills[item.name] = { agents: [], mode: "link", scope: "user" };
  }
  const entry = manifest.skills[item.name]!;
  entry.agents = [...new Set([...entry.agents, ...item.sources.flatMap((s) => s.agents)])].sort();
  await writeManifest(hub.manifestPath, manifest);

  // Replace each copy, linking only where the agent does not already see the skill elsewhere.
  const assigned = profiles.filter((p) => entry.agents.includes(p.id));
  const healthy: string[] = [];
  for (const group of planLinkGroups(assigned)) {
    const linkPath = path.join(group.dir, item.name);
    const source = item.sources.find((s) => samePath(s.path, linkPath));
    if (!source) {
      const onDisk = await readLinkTarget(linkPath);
      if (onDisk && samePath(onDisk, target)) healthy.push(group.dir);
      continue;
    }
    result.backups.push(await moveToBackup(hub, source.path, `import-${source.agents.join("+")}`, item.name));
    if (group.coveredBy && healthy.some((d) => samePath(d, group.coveredBy!.dir))) continue;
    await recordStateLink(state, linkPath, item.name, target, await createDirLink(target, linkPath));
    await writeState(hub.statePath, state);
    result.linked.push(linkPath);
    healthy.push(group.dir);
  }
}
