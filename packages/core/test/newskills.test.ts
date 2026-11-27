import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  builtinAgents,
  isAgentInstalled,
  loadProfiles,
  openHub,
  planSync,
  readConfig,
  readLinkTarget,
  readManifest,
  SkillsymError,
  sync,
  writeNewSkillsAgents,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claudeLink = (skill: string) => path.join(userHome, ".claude", "skills", skill);
const setConfig = (extra: Record<string, unknown>) => fs.writeFile(hub.configPath, JSON.stringify({ version: 1, agents: [], ...extra }));

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(path.join(userHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(userHome, ".codex"), { recursive: true });
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
});

afterEach(async () => {
  await removeDir(root);
});

describe("newSkills config", () => {
  it.each([
    ["not an object", { newSkills: ["claude"] }],
    ["agents not an array", { newSkills: { agents: "claude" } }],
    ["agents with a non-string", { newSkills: { agents: [1] } }],
    ["unknown agent id", { newSkills: { agents: ["nope"] } }],
  ])("rejects an invalid newSkills (%s), naming the field", async (_label, extra) => {
    await setConfig(extra);
    const err = await readConfig(hub.configPath).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SkillsymError);
    expect((err as SkillsymError).code).toBe("CONFIG_INVALID");
    expect((err as SkillsymError).message).toContain("newSkills.agents");
  });

  it("accepts '*', built-in ids and ids from config.agents", async () => {
    await setConfig({ agents: [{ id: "mine", skillsDir: "~/mine" }], newSkills: { agents: ["*", "claude", "mine"] } });
    expect((await readConfig(hub.configPath)).newSkills).toEqual({ agents: ["*", "claude", "mine"] });
  });

  it("writing keeps agents and other fields, and refuses unknown ids", async () => {
    await setConfig({ agents: [{ id: "mine", skillsDir: "~/mine" }], futureField: { a: 1 } });
    await writeNewSkillsAgents(hub, ["claude", "mine"]);
    const raw = JSON.parse(await fs.readFile(hub.configPath, "utf8"));
    expect(raw).toEqual({ version: 1, agents: [{ id: "mine", skillsDir: "~/mine" }], futureField: { a: 1 }, newSkills: { agents: ["claude", "mine"] } });
    await expect(writeNewSkillsAgents(hub, ["nope"])).rejects.toBeInstanceOf(SkillsymError);
  });
});

describe("sync registers new hub skills", () => {
  it("with newSkills.agents ['*'] registers foo, links every installed agent, and the second sync does nothing", async () => {
    await makeSkill(hub.skillsDir, "foo");
    await setConfig({ newSkills: { agents: ["*"] } });
    const first = await sync(hub, { profiles });
    expect(first.registrations).toHaveLength(1);
    expect(first.unregistered).toEqual([]);
    const installed: string[] = [];
    for (const p of profiles) if (await isAgentInstalled(p)) installed.push(p.id);
    expect((await readManifest(hub.manifestPath)).skills.foo!.agents).toEqual(installed.sort());
    expect(await readLinkTarget(claudeLink("foo"))).toBe(path.join(hub.skillsDir, "foo"));

    const second = await sync(hub, { profiles });
    expect(second.actions).toEqual([]);
    expect(second.registrations).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });

  it("with ['claude'] only claude gets it", async () => {
    await makeSkill(hub.skillsDir, "foo");
    await setConfig({ newSkills: { agents: ["claude"] } });
    await sync(hub, { profiles });
    expect((await readManifest(hub.manifestPath)).skills.foo!.agents).toEqual(["claude"]);
    expect(await readLinkTarget(claudeLink("foo"))).not.toBeNull();
    expect(await readLinkTarget(path.join(userHome, ".agents", "skills", "foo"))).toBeNull();
  });

  it("an explicit per-skill choice from the caller is used when config is unset", async () => {
    await makeSkill(hub.skillsDir, "foo");
    await sync(hub, { profiles, newSkillAgents: { foo: ["claude"] } });
    expect((await readManifest(hub.manifestPath)).skills.foo!.agents).toEqual(["claude"]);
  });

  it("with nothing set reports the folder and changes nothing", async () => {
    await makeSkill(hub.skillsDir, "foo");
    const before = await fs.readFile(hub.manifestPath, "utf8");
    const result = await sync(hub, { profiles });
    expect(result.unregistered).toMatchObject([{ name: "foo" }]);
    expect(result.registrations).toEqual([]);
    expect(await fs.readFile(hub.manifestPath, "utf8")).toBe(before);
    expect(await readLinkTarget(claudeLink("foo"))).toBeNull();
  });

  it("never registers a name-mismatch folder, even with agents set", async () => {
    const dir = await makeSkill(hub.skillsDir, "foo");
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: other\ndescription: x\n---\n");
    await setConfig({ newSkills: { agents: ["*"] } });
    const result = await sync(hub, { profiles });
    expect(result.unregistered).toMatchObject([{ name: "foo", reason: "name-mismatch" }]);
    expect((await readManifest(hub.manifestPath)).skills.foo).toBeUndefined();
  });

  it("dry-run (planSync) lists what would be registered and writes nothing", async () => {
    await makeSkill(hub.skillsDir, "foo");
    await setConfig({ newSkills: { agents: ["claude"] } });
    const before = await fs.readFile(hub.manifestPath, "utf8");
    const plan = await planSync(hub, { profiles });
    expect(plan.registrations).toEqual([{ skill: "foo", agents: ["claude"] }]);
    expect(await fs.readFile(hub.manifestPath, "utf8")).toBe(before);
    expect(await readLinkTarget(claudeLink("foo"))).toBeNull();
  });

  it("skill and agent filters apply to new skills", async () => {
    await makeSkill(hub.skillsDir, "foo");
    await makeSkill(hub.skillsDir, "bar");
    await setConfig({ newSkills: { agents: ["claude", "codex"] } });
    const result = await sync(hub, { profiles, skills: ["foo"], agents: ["claude"] });
    expect(result.registrations).toEqual([{ skill: "foo", agents: ["claude"] }]);
    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills.foo!.agents).toEqual(["claude"]);
    expect(manifest.skills.bar).toBeUndefined();
  });

  it("config agents are usable as targets", async () => {
    await makeSkill(hub.skillsDir, "foo");
    await setConfig({ agents: [{ id: "mine", skillsDir: path.join(userHome, ".mine", "skills") }], newSkills: { agents: ["mine"] } });
    const custom = await loadProfiles(hub, userHome);
    await sync(hub, { profiles: custom });
    expect(await readLinkTarget(path.join(userHome, ".mine", "skills", "foo"))).toBe(path.join(hub.skillsDir, "foo"));
  });
});
