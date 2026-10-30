import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  hashSkillDir,
  listSkills,
  openHub,
  readLinkTarget,
  readManifest,
  readState,
  SkillsymError,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "refs/a.md": "A" }));
  await addSkill(hub, await makeSkill(path.join(root, "src"), "research"));
});

afterEach(async () => {
  await removeDir(root);
});

const claudeDir = () => path.join(userHome, ".claude", "skills");
const agentsDir = () => path.join(userHome, ".agents", "skills");

function assign(skills: string[], agents: string[]) {
  return assignSkills(hub, { skills, agents, profiles });
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillsymError);
  expect((err as SkillsymError).code).toBe(code);
}

describe("assign", () => {
  it("links the hub skill into the agent folder and records it", async () => {
    const { results } = await assign(["coding"], ["claude"]);
    const link = path.join(claudeDir(), "coding");

    expect(results).toEqual([{ skill: "coding", agents: ["claude"], path: link, outcome: "linked" }]);
    expect(await readLinkTarget(link)).toBe(path.join(hub.skillsDir, "coding"));
    expect(await fs.readFile(path.join(link, "refs", "a.md"), "utf8")).toBe("A");

    const state = await readState(hub.statePath);
    expect(state.links).toHaveLength(1);
    expect(state.links[0]).toMatchObject({
      path: link,
      target: path.join(hub.skillsDir, "coding"),
      skill: "coding",
      kind: process.platform === "win32" ? "junction" : "symlink",
      hash: await hashSkillDir(path.join(hub.skillsDir, "coding")),
    });
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual(["claude"]);
    expect((await listSkills(hub)).find((s) => s.name === "coding")!.agents).toEqual(["claude"]);
  });

  it("is a link, not a copy: edits in the hub show up through it", async () => {
    await assign(["coding"], ["claude"]);
    await fs.writeFile(path.join(hub.skillsDir, "coding", "SKILL.md"), "edited");
    expect(await fs.readFile(path.join(claudeDir(), "coding", "SKILL.md"), "utf8")).toBe("edited");
  });

  it("creates the agent's skills folder when it does not exist yet", async () => {
    await assign(["coding"], ["cursor"]);
    expect(await readLinkTarget(path.join(userHome, ".cursor", "skills", "coding"))).toBe(path.join(hub.skillsDir, "coding"));
  });

  it("is idempotent: assigning again changes nothing", async () => {
    await assign(["coding"], ["claude"]);
    const stateBefore = await fs.readFile(hub.statePath, "utf8");
    const manifestBefore = await fs.readFile(hub.manifestPath, "utf8");

    const { results } = await assign(["coding"], ["claude"]);

    expect(results.map((r) => r.outcome)).toEqual(["already-linked"]);
    expect(await fs.readFile(hub.statePath, "utf8")).toBe(stateBefore);
    expect(await fs.readFile(hub.manifestPath, "utf8")).toBe(manifestBefore);
  });

  it("creates one link for agents that share a folder (codex and universal)", async () => {
    const { results } = await assign(["coding"], ["codex,universal"]);
    expect(results).toEqual([
      { skill: "coding", agents: ["codex", "universal"], path: path.join(agentsDir(), "coding"), outcome: "linked" },
    ]);
    expect((await readState(hub.statePath)).links).toHaveLength(1);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual(["codex", "universal"]);
  });

  it("assigns every hub skill with '*'", async () => {
    const { results } = await assign(["*"], ["claude"]);
    expect(results.map((r) => r.skill)).toEqual(["coding", "research"]);
    expect(results.every((r) => r.outcome === "linked")).toBe(true);
  });

  it("'*' agents means installed agents only (universal always counts)", async () => {
    await fs.mkdir(path.join(userHome, ".claude"));
    const { results } = await assign(["coding"], ["*"]);
    expect(results.map((r) => r.agents)).toEqual([["claude"], ["universal"]]);
  });
});

describe("assign leaves things it did not create alone", () => {
  it("reports a real folder at the target path as blocked and does not touch it", async () => {
    const existing = await makeSkill(claudeDir(), "coding");
    const before = await hashSkillDir(existing);

    const { results } = await assign(["coding"], ["claude"]);

    expect(results[0]).toMatchObject({ outcome: "blocked" });
    expect(results[0]!.reason).toMatch(/import/);
    expect(await readLinkTarget(existing)).toBeNull();
    expect(await hashSkillDir(existing)).toBe(before);
    expect((await readState(hub.statePath)).links).toEqual([]);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual([]);
  });

  it("reports a foreign link at the target path as blocked and keeps it", async () => {
    const elsewhere = await makeSkill(path.join(root, "other-tool"), "coding");
    await fs.mkdir(claudeDir(), { recursive: true });
    await fs.symlink(elsewhere, path.join(claudeDir(), "coding"), process.platform === "win32" ? "junction" : "dir");

    const { results } = await assign(["coding"], ["claude"]);

    expect(results[0]!.outcome).toBe("blocked");
    expect(await readLinkTarget(path.join(claudeDir(), "coding"))).toBe(elsewhere);
  });

  it("still links the other agents when one target is blocked", async () => {
    await makeSkill(claudeDir(), "coding");
    const { results } = await assign(["coding"], ["claude", "cursor"]);
    expect(results.map((r) => [r.agents[0], r.outcome])).toEqual([
      ["claude", "blocked"],
      ["cursor", "linked"],
    ]);
    expect((await readManifest(hub.manifestPath)).skills.coding!.agents).toEqual(["cursor"]);
  });

  it("rejects unknown agents before changing anything", async () => {
    await expectCode(assign(["coding"], ["claude", "vscode"]), "UNKNOWN_AGENT");
    expect(await readLinkTarget(path.join(claudeDir(), "coding"))).toBeNull();
  });

  it("rejects skills that are not in the hub before changing anything", async () => {
    await expectCode(assign(["coding", "nope"], ["claude"]), "SKILL_NOT_IN_HUB");
    expect(await readLinkTarget(path.join(claudeDir(), "coding"))).toBeNull();
  });
});
