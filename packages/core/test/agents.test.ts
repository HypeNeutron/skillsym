import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  loadProfiles,
  openHub,
  planLinkGroups,
  readLinkTarget,
  readManifest,
  removeSkills,
  scanStatus,
  SkillsymError,
  sync,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const dir = (...p: string[]) => path.join(userHome, ...p);
const hubSkill = (skill = "coding") => path.join(hub.skillsDir, skill);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding"));
});

afterEach(async () => {
  await removeDir(root);
});

const assign = (agents: string[]) => assignSkills(hub, { skills: ["coding"], agents, profiles });
const statuses = async () =>
  (await scanStatus(hub, { profiles })).entries.map((e) => `${e.agents.join("+")}:${e.status}`);

describe("an agent that already reads another agent's folder gets no second link", () => {
  it("Cursor is covered by Claude's link", async () => {
    const { results } = await assign(["claude", "cursor"]);

    expect(results.map((r) => [r.agents.join("+"), r.outcome])).toEqual([
      ["claude", "linked"],
      ["cursor", "covered"],
    ]);
    expect(results[1]!.reason).toContain(dir(".claude", "skills"));
    expect(await listDir(dir(".cursor", "skills"))).toEqual([]);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual(["claude", "cursor"]);

    const report = await scanStatus(hub, { profiles });
    expect(report.entries.map((e) => `${e.agents.join("+")}:${e.status}`)).toEqual(["claude:synced", "cursor:covered"]);
    expect(report.clean).toBe(true);
  });

  it("Cursor is covered by the shared ~/.agents/skills link (codex/universal)", async () => {
    const { results } = await assign(["codex", "universal", "cursor"]);
    expect(results.map((r) => [r.agents.join("+"), r.outcome])).toEqual([
      ["codex+universal", "linked"],
      ["cursor", "covered"],
    ]);
  });

  it("when Claude is unassigned, sync gives Cursor its own link", async () => {
    await assign(["claude", "cursor"]);
    await removeSkills(hub, { skills: ["coding"], agents: ["claude"], profiles });
    expect(await statuses()).toEqual(["cursor:missing"]);

    await sync(hub, { profiles });

    expect(await readLinkTarget(dir(".cursor", "skills", "coding"))).toBe(hubSkill());
    expect(await statuses()).toEqual(["cursor:synced"]);
  });

  it("when Claude is added after Cursor, Cursor's own link becomes a duplicate that sync removes", async () => {
    await assign(["cursor"]);
    await assign(["claude"]);
    const before = await scanStatus(hub, { profiles });
    expect(before.entries.map((e) => `${e.agents.join("+")}:${e.status}`)).toEqual(["claude:synced", "cursor:duplicate"]);
    expect(before.clean).toBe(false);

    const { results } = await sync(hub, { profiles });

    expect(results.map((r) => r.type)).toEqual(["unlink-duplicate"]);
    expect(await listDir(dir(".cursor", "skills"))).toEqual([]);
    expect(await statuses()).toEqual(["claude:synced", "cursor:covered"]);
  });

  it("a blocked Claude path does not count as coverage", async () => {
    await makeSkill(dir(".claude", "skills"), "coding");
    const { results } = await assign(["claude", "cursor"]);
    expect(results.map((r) => r.outcome)).toEqual(["blocked", "linked"]);
  });

  it("two agents that read each other's folders never cover each other", () => {
    const a: AgentProfile = { id: "a", displayName: "A", skillsDir: dir("a"), alsoReads: [dir("b")], reload: "unknown" };
    const b: AgentProfile = { id: "b", displayName: "B", skillsDir: dir("b"), alsoReads: [dir("a")], reload: "unknown" };
    const groups = planLinkGroups([a, b]);
    expect(groups.filter((g) => !g.coveredBy)).toHaveLength(1);
    expect(groups.filter((g) => g.coveredBy)).toHaveLength(1);
  });
});

describe("custom agent profiles from config.json", () => {
  async function writeConfig(config: unknown) {
    await fs.writeFile(hub.configPath, JSON.stringify(config));
  }

  it("adds a new agent, with ~ expanded to the home folder", async () => {
    await writeConfig({ version: 1, agents: [{ id: "windsurf", skillsDir: "~/.windsurf/skills" }] });
    profiles = await loadProfiles(hub, userHome);

    await assign(["windsurf"]);

    expect(await readLinkTarget(dir(".windsurf", "skills", "coding"))).toBe(hubSkill());
    expect(profiles.map((p) => p.id)).toEqual(["claude", "codex", "cursor", "universal", "windsurf"]);
  });

  it("replaces a built-in agent with the same id", async () => {
    await writeConfig({ version: 1, agents: [{ id: "claude", skillsDir: "~/custom/claude-skills" }] });
    profiles = await loadProfiles(hub, userHome);

    await assign(["claude"]);

    expect(await readLinkTarget(dir("custom", "claude-skills", "coding"))).toBe(hubSkill());
    expect(profiles.filter((p) => p.id === "claude")).toHaveLength(1);
  });

  it("honours alsoReads for custom agents", async () => {
    await writeConfig({ version: 1, agents: [{ id: "reader", skillsDir: "~/.reader/skills", alsoReads: ["~/.claude/skills"] }] });
    profiles = await loadProfiles(hub, userHome);
    const { results } = await assign(["claude", "reader"]);
    expect(results.map((r) => r.outcome)).toEqual(["linked", "covered"]);
  });

  it("uses only the built-ins when there is no config", async () => {
    expect((await loadProfiles(hub, userHome)).map((p) => p.id)).toEqual(["claude", "codex", "cursor", "universal"]);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["wrong version", JSON.stringify({ version: 2, agents: [] })],
    ["missing skillsDir", JSON.stringify({ version: 1, agents: [{ id: "x" }] })],
    ["bad id", JSON.stringify({ version: 1, agents: [{ id: "has space", skillsDir: "~/x" }] })],
    ["duplicate id", JSON.stringify({ version: 1, agents: [{ id: "x", skillsDir: "~/x" }, { id: "x", skillsDir: "~/y" }] })],
    ["bad reload", JSON.stringify({ version: 1, agents: [{ id: "x", skillsDir: "~/x", reload: "sometimes" }] })],
  ])("rejects an invalid config (%s)", async (_label, text) => {
    await fs.writeFile(hub.configPath, text);
    const err = await loadProfiles(hub, userHome).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillsymError);
    expect((err as SkillsymError).code).toBe("CONFIG_INVALID");
  });
});
