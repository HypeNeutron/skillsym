import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrary,
  addSkill,
  applyAntigravityMigration,
  assignSkills,
  generatedManifestPath,
  loadProfiles,
  openHub,
  planAntigravityMigration,
  readConfig,
  readManifest,
  readState,
  scanStatus,
  type Hub,
} from "../src/index.js";
import { makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(path.join(userHome, ".gemini", "config"), { recursive: true });
  hub = await openHub(path.join(root, "hub"));
});

afterEach(async () => {
  await removeDir(root);
});

describe("antigravity migration", () => {
  const skillsJsonPath = () => path.join(userHome, ".gemini", "config", "skills.json");
  const agySkillsDir = () => path.join(userHome, ".gemini", "config", "skills");

  it("migrates legacy gemini config, owned junctions, and broad skills.json entries while preserving custom entries and real folders", async () => {
    await fs.writeFile(
      hub.configPath,
      JSON.stringify({
        version: 1,
        agents: [
          { id: "gemini", skillsDir: "~/.gemini/config/skills" },
          { id: "windsurf", skillsDir: "~/.windsurf/skills" },
        ],
      }),
    );
    await addSkill(hub, await makeSkill(path.join(root, "src"), "coding"));
    const lib = path.join(root, "lib");
    await makeSkill(lib, "lib-skill");
    await addLibrary(hub, lib, { link: true });

    let profiles = await loadProfiles(hub, userHome);
    await assignSkills(hub, { skills: ["coding", "lib-skill"], agents: ["gemini"], profiles });
    // Real unmanaged folder in ~/.gemini/config/skills must survive untouched
    await makeSkill(agySkillsDir(), "real-unmanaged", { "keep.txt": "keep" });

    // Broad manual entries in skills.json + custom manual entry
    await fs.writeFile(
      skillsJsonPath(),
      JSON.stringify({
        entries: [
          { path: hub.skillsDir.replace(/\\/g, "/") },
          { path: path.join(userHome, ".agents", "skills").replace(/\\/g, "/") },
          { path: "~/custom-manual", exclude: ["draft"] },
        ],
      }),
    );

    const plan = await planAntigravityMigration(hub, { profiles, homedir: userHome });
    expect(plan).toMatchObject({
      needed: true,
      legacyConfigAgent: true,
      manifestSkillsToMove: ["coding", "lib-skill"],
      broadSkillsJsonEntries: [hub.skillsDir.replace(/\\/g, "/"), path.join(userHome, ".agents", "skills").replace(/\\/g, "/")],
    });
    expect(plan.ownedLinksToRemove).toHaveLength(2);

    const res = await applyAntigravityMigration(hub, { homedir: userHome });
    expect(res).toMatchObject({
      applied: true,
      unlinkedCount: 2,
      removedBroadEntries: 2,
    });
    expect(res.backups).toHaveLength(3);

    // Config no longer overrides gemini, keeps windsurf
    const cfg = await readConfig(hub.configPath);
    expect(cfg.agents.map((a) => a.id)).toEqual(["windsurf"]);

    // Manifest moved gemini -> antigravity
    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills.coding!.agents).toEqual(["antigravity"]);
    expect(manifest.skills["lib-skill"]!.agents).toEqual(["antigravity"]);

    // Owned junctions removed, unmanaged real folder preserved
    await expect(fs.lstat(path.join(agySkillsDir(), "coding"))).rejects.toThrow();
    await expect(fs.lstat(path.join(agySkillsDir(), "lib-skill"))).rejects.toThrow();
    expect(await fs.readFile(path.join(agySkillsDir(), "real-unmanaged", "keep.txt"), "utf8")).toBe("keep");

    // Broad entries removed, custom entry preserved, inherits added
    const skillsJson = JSON.parse(await fs.readFile(skillsJsonPath(), "utf8"));
    expect(skillsJson.entries).toEqual([{ path: "~/custom-manual", exclude: ["draft"] }]);
    expect(skillsJson.inherits).toEqual([{ path: generatedManifestPath(hub, "antigravity").replace(/\\/g, "/") }]);

    // Status is clean (only unmanaged real-unmanaged)
    profiles = await loadProfiles(hub, userHome);
    const report = await scanStatus(hub, { profiles });
    expect(report.clean).toBe(true);
    expect(report.warnings.filter((w) => w.code === "LEGACY_GEMINI_CONFIG" || w.code === "SKILLS_JSON_BROAD_ENTRY")).toEqual([]);
    expect((await readState(hub.statePath)).links).toEqual([]);

    // Re-running migration is a no-op
    const second = await applyAntigravityMigration(hub, { homedir: userHome });
    expect(second.needed).toBe(false);
    expect(second.applied).toBe(false);
  });
});
