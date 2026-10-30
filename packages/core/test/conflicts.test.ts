import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  hashSkillDir,
  openHub,
  readLinkTarget,
  readManifest,
  readState,
  resolveConflicts,
  scanStatus,
  sync,
  type AgentProfile,
  type ConflictDecision,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claudeDir = () => path.join(userHome, ".claude", "skills");
const cursorDir = () => path.join(userHome, ".cursor", "skills");
const claudeLink = (skill = "coding") => path.join(claudeDir(), skill);
const hubSkill = (skill = "coding") => path.join(hub.skillsDir, skill);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "hub.md": "hub version" }));
  await assignSkills(hub, { skills: ["coding"], agents: ["claude", "cursor"], profiles });
});

afterEach(async () => {
  await removeDir(root);
});

async function removeLink(p: string) {
  try {
    await fs.unlink(p);
  } catch {
    await fs.rmdir(p);
  }
}

/** Simulate an agent (or another tool) writing a real, different folder over our link. */
async function replaceWithAgentEdit() {
  await removeLink(claudeLink());
  await makeSkill(claudeDir(), "coding", { "agent.md": "agent version" });
}

const resolve = (decisions: ConflictDecision[]) => resolveConflicts(hub, decisions, { profiles });
const statuses = async () => (await scanStatus(hub, { profiles })).entries.map((e) => `${e.skill}:${e.agents.join("+")}:${e.status}`);

describe("replaced by different content", () => {
  beforeEach(replaceWithAgentEdit);

  it("restore: backs up the agent's folder and puts our link back", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "restore" }]);

    expect(r).toMatchObject({ ok: true, choice: "restore" });
    expect(await readLinkTarget(claudeLink())).toBe(hubSkill());
    expect(r!.backups).toHaveLength(1);
    expect(await fs.readFile(path.join(r!.backups[0]!, "agent.md"), "utf8")).toBe("agent version");
    expect(await statuses()).toEqual(["coding:claude:synced", "coding:cursor:synced"]);
  });

  it("adopt: the agent's version becomes the hub's, every agent sees it, old hub version is backed up", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "adopt" }]);

    expect(r!.ok).toBe(true);
    expect(await fs.readFile(path.join(hubSkill(), "agent.md"), "utf8")).toBe("agent version");
    expect(await listDir(hubSkill())).not.toContain("hub.md");
    expect(await fs.readFile(path.join(cursorDir(), "coding", "agent.md"), "utf8")).toBe("agent version");
    expect(await readLinkTarget(claudeLink())).toBe(hubSkill());

    const hubBackup = r!.backups.find((b) => (b.split(path.sep).includes("hub")));
    expect(await fs.readFile(path.join(hubBackup!, "hub.md"), "utf8")).toBe("hub version");
    expect(await statuses()).toEqual(["coding:claude:synced", "coding:cursor:synced"]);
  });

  it("fork: keeps the agent's version as a new skill for that agent only", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "fork" }]);

    expect(r).toMatchObject({ ok: true, newSkill: "coding-claude" });
    expect(await readLinkTarget(claudeLink("coding-claude"))).toBe(hubSkill("coding-claude"));
    expect(await fs.readFile(path.join(hubSkill("coding-claude"), "agent.md"), "utf8")).toBe("agent version");
    expect(await fs.readFile(path.join(hubSkill(), "hub.md"), "utf8")).toBe("hub version");
    expect(await listDir(claudeDir())).toEqual(["coding-claude"]);

    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills.coding!.agents).toEqual(["cursor"]);
    expect(manifest.skills["coding-claude"]!.agents).toEqual(["claude"]);
    expect(await statuses()).toEqual(["coding:cursor:synced", "coding-claude:claude:synced"]);
  });

  it("fork: uses a custom name, and refuses a taken name without changing anything", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "src"), "taken"));
    const [bad] = await resolve([{ path: claudeLink(), choice: "fork", forkName: "taken" }]);
    expect(bad).toMatchObject({ ok: false });
    expect(await fs.readFile(path.join(claudeLink(), "agent.md"), "utf8")).toBe("agent version");

    const [good] = await resolve([{ path: claudeLink(), choice: "fork", forkName: "coding-mine" }]);
    expect(good).toMatchObject({ ok: true, newSkill: "coding-mine" });
  });

  it("skip: changes nothing", async () => {
    const before = await hashSkillDir(claudeLink());
    const [r] = await resolve([{ path: claudeLink(), choice: "skip" }]);
    expect(r!.ok).toBe(true);
    expect(await hashSkillDir(claudeLink())).toBe(before);
    expect(await readLinkTarget(claudeLink())).toBeNull();
  });

  it("rejects a choice that does not fit the conflict", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "drop" }]);
    expect(r).toMatchObject({ ok: false });
    expect(r!.error).toMatch(/not available/);
  });
});

describe("adopt when the replacement is someone else's link", () => {
  it("copies the content into the hub and leaves the other folder alone", async () => {
    const external = await makeSkill(path.join(root, "external"), "coding", { "ext.md": "external" });
    await removeLink(claudeLink());
    await fs.symlink(external, claudeLink(), process.platform === "win32" ? "junction" : "dir");

    const [r] = await resolve([{ path: claudeLink(), choice: "adopt" }]);

    expect(r!.ok).toBe(true);
    expect(await fs.readFile(path.join(hubSkill(), "ext.md"), "utf8")).toBe("external");
    expect(await listDir(external)).toEqual(["SKILL.md", "ext.md"]);
    expect(await readLinkTarget(claudeLink())).toBe(hubSkill());
  });
});

describe("our link was removed", () => {
  beforeEach(async () => removeLink(claudeLink()));

  it("restore: recreates the link", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "restore" }]);
    expect(r!.ok).toBe(true);
    expect(await readLinkTarget(claudeLink())).toBe(hubSkill());
  });

  it("drop: unassigns the skill from that agent and stops tracking the path", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "drop" }]);
    expect(r!.ok).toBe(true);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual(["cursor"]);
    expect((await readState(hub.statePath)).links.map((l) => l.path)).toEqual([path.join(cursorDir(), "coding")]);
    expect((await scanStatus(hub, { profiles })).clean).toBe(true);
  });
});

describe("other cases", () => {
  it("drop for a skill whose hub folder is gone removes our dangling links", async () => {
    await fs.rm(hubSkill(), { recursive: true });
    const { conflicts } = await sync(hub, { profiles });
    const results = await resolve(conflicts.map((c) => ({ path: c.path, choice: "drop" as const })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await listDir(claudeDir())).toEqual([]);
    expect(await listDir(cursorDir())).toEqual([]);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual([]);
  });

  it("reports a decision for a path that has no conflict", async () => {
    const [r] = await resolve([{ path: claudeLink(), choice: "restore" }]);
    expect(r).toMatchObject({ ok: false, error: "no conflict at this path any more" });
  });
});
