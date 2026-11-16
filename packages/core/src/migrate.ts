import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentDelivery, builtinAgents, type AgentProfile } from "./agents.js";
import { backupStamp, copyToBackup } from "./backup.js";
import { loadProfiles, readConfig } from "./config.js";
import { isFile, writeFileAtomic } from "./fsutil.js";
import type { Hub } from "./hub.js";
import { readLinkTarget, removeDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest } from "./manifest.js";
import { applySkillsJsonDelivery, readTargetSkillsJson } from "./skills-json.js";
import { readState, samePath, writeState } from "./state.js";

export interface MigrationPlan {
  needed: boolean;
  legacyConfigAgent: boolean;
  manifestSkillsToMove: string[];
  ownedLinksToRemove: string[];
  broadSkillsJsonEntries: string[];
  skillsJsonPath: string;
  configPath: string;
}

export interface MigrationResult extends MigrationPlan {
  applied: boolean;
  backups: string[];
  unlinkedCount: number;
  removedBroadEntries: number;
}

export interface MigrationOptions {
  profiles?: AgentProfile[];
  homedir?: string;
  lock?: LockOptions;
}

function expandConfigPath(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir, p.slice(2));
  return path.resolve(homedir, p);
}

function isBroadEntry(item: unknown, skillsJsonPath: string, hubSkillsDir: string, universalDir?: string): string | null {
  if (typeof item !== "object" || item === null) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.path !== "string" || rec.include_only !== undefined || rec.exclude !== undefined) return null;
  const resolved = path.resolve(path.dirname(skillsJsonPath), rec.path);
  if (samePath(resolved, hubSkillsDir) || (universalDir && samePath(resolved, universalDir))) {
    return rec.path;
  }
  return null;
}

/**
 * Inspect whether a hub has a legacy custom `gemini` override pointing at Antigravity's folder,
 * skillsym-owned junctions inside it, or broad whole-folder entries in `skills.json`. Read-only.
 */
export async function planAntigravityMigration(hub: Hub, options: MigrationOptions = {}): Promise<MigrationPlan> {
  const homedir = options.homedir ?? os.homedir();
  const profiles = options.profiles ?? builtinAgents(homedir);
  const antigravity = profiles.find((p) => p.id === "antigravity" && agentDelivery(p) === "skills-json" && p.skillsJsonPath);
  const universalDir = profiles.find((p) => p.id === "universal")?.skillsDir;

  if (!antigravity?.skillsJsonPath) {
    return {
      needed: false,
      legacyConfigAgent: false,
      manifestSkillsToMove: [],
      ownedLinksToRemove: [],
      broadSkillsJsonEntries: [],
      skillsJsonPath: "",
      configPath: hub.configPath,
    };
  }

  const config = await readConfig(hub.configPath);
  const legacy = config.agents.find((a) => a.id === "gemini" && samePath(expandConfigPath(a.skillsDir, homedir), antigravity.skillsDir));
  const legacyConfigAgent = Boolean(legacy);

  const manifest = await readManifest(hub.manifestPath);
  const manifestSkillsToMove = legacyConfigAgent
    ? Object.keys(manifest.skills)
        .sort()
        .filter((name) => manifest.skills[name]!.agents.includes("gemini"))
    : [];

  const state = await readState(hub.statePath);
  const ownedLinksToRemove: string[] = [];
  for (const link of state.links) {
    if (!samePath(path.dirname(link.path), antigravity.skillsDir)) continue;
    if ((await readLinkTarget(link.path)) !== null) ownedLinksToRemove.push(link.path);
  }

  const broadSkillsJsonEntries: string[] = [];
  const target = await readTargetSkillsJson(antigravity.skillsJsonPath);
  if (target.exists && Array.isArray(target.rawObj.entries)) {
    for (const item of target.rawObj.entries) {
      const matched = isBroadEntry(item, antigravity.skillsJsonPath, hub.skillsDir, universalDir);
      if (matched !== null) broadSkillsJsonEntries.push(matched);
    }
  }

  const needed =
    legacyConfigAgent || manifestSkillsToMove.length > 0 || ownedLinksToRemove.length > 0 || broadSkillsJsonEntries.length > 0;
  return {
    needed,
    legacyConfigAgent,
    manifestSkillsToMove,
    ownedLinksToRemove: ownedLinksToRemove.sort(),
    broadSkillsJsonEntries,
    skillsJsonPath: antigravity.skillsJsonPath,
    configPath: hub.configPath,
  };
}

/**
 * Migrate legacy Antigravity configuration (`gemini` override + junctions + broad `skills.json`
 * entries) to built-in `antigravity` `skills-json` delivery. Backs up every edited file first.
 */
export async function applyAntigravityMigration(hub: Hub, options: MigrationOptions = {}): Promise<MigrationResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const homedir = options.homedir ?? os.homedir();
      const plan = await planAntigravityMigration(hub, options);
      if (!plan.needed) {
        return { ...plan, applied: false, backups: [], unlinkedCount: 0, removedBroadEntries: 0 };
      }

      const stamp = backupStamp();
      const backups: string[] = [];
      if (plan.legacyConfigAgent && (await isFile(hub.configPath))) {
        backups.push(await copyToBackup(hub, hub.configPath, "migrate", path.basename(hub.configPath), stamp));
      }
      if (plan.manifestSkillsToMove.length && (await isFile(hub.manifestPath))) {
        backups.push(await copyToBackup(hub, hub.manifestPath, "migrate", path.basename(hub.manifestPath), stamp));
      }
      if (plan.broadSkillsJsonEntries.length && plan.skillsJsonPath && (await isFile(plan.skillsJsonPath))) {
        backups.push(await copyToBackup(hub, plan.skillsJsonPath, "migrate", path.basename(plan.skillsJsonPath), stamp));
      }

      if (plan.legacyConfigAgent) {
        const raw = JSON.parse((await fs.readFile(hub.configPath, "utf8")).replace(/^\ufeff/, "")) as Record<string, unknown>;
        const agents = Array.isArray(raw.agents)
          ? raw.agents.filter((a) => !(typeof a === "object" && a !== null && (a as { id?: unknown }).id === "gemini"))
          : [];
        await writeFileAtomic(hub.configPath, JSON.stringify({ ...raw, agents }, null, 2) + "\n");
      }

      const manifest = await readManifest(hub.manifestPath);
      if (plan.manifestSkillsToMove.length) {
        for (const name of plan.manifestSkillsToMove) {
          const entry = manifest.skills[name];
          if (!entry) continue;
          entry.agents = [...new Set(entry.agents.map((a) => (a === "gemini" ? "antigravity" : a)))].sort();
        }
        await writeManifest(hub.manifestPath, manifest);
      }

      const state = await readState(hub.statePath);
      let unlinkedCount = 0;
      for (const linkPath of plan.ownedLinksToRemove) {
        if ((await readLinkTarget(linkPath)) !== null) {
          await removeDirLink(linkPath);
          unlinkedCount++;
        }
        state.links = state.links.filter((l) => !samePath(l.path, linkPath));
      }

      const profiles = options.profiles ?? (await loadProfiles(hub, homedir));
      const antigravity = profiles.find((p) => p.id === "antigravity")!;
      const universalDir = profiles.find((p) => p.id === "universal")?.skillsDir;

      let removedBroadEntries = 0;
      if (plan.broadSkillsJsonEntries.length && plan.skillsJsonPath) {
        const target = await readTargetSkillsJson(plan.skillsJsonPath);
        if (target.exists && Array.isArray(target.rawObj.entries)) {
          const kept = target.rawObj.entries.filter((item) => isBroadEntry(item, plan.skillsJsonPath, hub.skillsDir, universalDir) === null);
          removedBroadEntries = target.rawObj.entries.length - kept.length;
          await writeFileAtomic(plan.skillsJsonPath, JSON.stringify({ ...target.rawObj, entries: kept }, null, 2) + "\n");
        }
      }

      const hasAntigravitySkills = Object.values(manifest.skills).some((e) => e.agents.includes(antigravity.id));
      if (hasAntigravitySkills) {
        const applied = await applySkillsJsonDelivery(hub, antigravity, manifest, state, { forceOverwrite: true });
        if (!applied.ok) throw new Error(applied.reason);
      }
      await writeState(hub.statePath, state);

      return {
        ...plan,
        applied: true,
        backups,
        unlinkedCount,
        removedBroadEntries,
      };
    },
    options.lock,
  );
}
