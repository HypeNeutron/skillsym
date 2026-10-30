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
  removeSkills,
  scanStatus,
  SkillsymError,
  writeManifest,
  type AgentProfile,
  type Hub,
  type RemoveOptions,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const dir = (agent: "claude" | "cursor" | "agents") =>
  agent === "agents" ? path.join(userHome, ".agents", "skills") : path.join(userHome, `.${agent}`, "skills");
const hubSkill = (skill = "coding") => path.join(hub.skillsDir, skill);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "a.md": "A" }));
  await addSkill(hub, await makeSkill(path.join(root, "src"), "research"));
  await assignSkills(hub, { skills: ["coding"], agents: ["claude", "cursor", "codex", "universal"], profiles });
  await assignSkills(hub, { skills: ["research"], agents: ["claude"], profiles });
});

afterEach(async () => {
  await removeDir(root);
});

const remove = (options: Omit<RemoveOptions, "profiles">) => removeSkills(hub, { ...options, profiles });
const agentsOf = async (skill: string) => (await readManifest(hub.manifestPath)).skills[skill]?.agents;

async function removeLink(p: string) {
  try {
    await fs.unlink(p);
  } catch {
    await fs.rmdir(p);
  }
}

describe("remove -a: unassign some agents", () => {
  it("removes only that agent's link and assignment", async () => {
    const { links, removedSkills } = await remove({ skills: ["coding"], agents: ["cursor"] });

    expect(links).toEqual([{ skill: "coding", agents: ["cursor"], path: path.join(dir("cursor"), "coding"), outcome: "unlinked" }]);
    expect(removedSkills).toEqual([]);
    expect(await listDir(dir("cursor"))).toEqual([]);
    expect(await readLinkTarget(path.join(dir("claude"), "coding"))).toBe(hubSkill());
    expect(await agentsOf("coding")).toEqual(["claude", "codex", "universal"]);
    expect(await listDir(hubSkill())).toEqual(["SKILL.md", "a.md"]);
    expect((await scanStatus(hub, { profiles })).clean).toBe(true);
  });

  it("keeps a shared link while another assigned agent still reads that folder", async () => {
    const first = await remove({ skills: ["coding"], agents: ["codex"] });
    expect(first.links[0]).toMatchObject({ agents: ["codex"], outcome: "kept-shared" });
    expect(await readLinkTarget(path.join(dir("agents"), "coding"))).toBe(hubSkill());

    const second = await remove({ skills: ["coding"], agents: ["universal"] });
    expect(second.links[0]).toMatchObject({ agents: ["universal"], outcome: "unlinked" });
    expect(await listDir(dir("agents"))).toEqual([]);
    expect(await agentsOf("coding")).toEqual(["claude", "cursor"]);
  });

  it("reports agents that were not assigned", async () => {
    const { links } = await remove({ skills: ["research"], agents: ["cursor"] });
    expect(links).toEqual([{ skill: "research", agents: ["cursor"], outcome: "not-assigned" }]);
  });

  it("leaves a folder that replaced our link alone, and stops tracking it", async () => {
    const p = path.join(dir("claude"), "coding");
    await removeLink(p);
    await makeSkill(dir("claude"), "coding", { "mine.md": "keep" });

    const { links } = await remove({ skills: ["coding"], agents: ["claude"] });

    expect(links[0]).toMatchObject({ outcome: "left-in-place" });
    expect(await fs.readFile(path.join(p, "mine.md"), "utf8")).toBe("keep");
    expect((await readState(hub.statePath)).links.some((l) => l.path === p)).toBe(false);
  });
});

describe("remove without -a: remove the skill entirely", () => {
  it("unlinks every agent, drops it from the manifest and moves the hub copy to backups", async () => {
    const hashBefore = await hashSkillDir(hubSkill());
    const { links, removedSkills } = await remove({ skills: ["coding"] });

    expect(links.map((l) => l.outcome)).toEqual(["unlinked", "unlinked", "unlinked"]);
    expect(await listDir(dir("cursor"))).toEqual([]);
    expect(await listDir(dir("agents"))).toEqual([]);
    expect(await listDir(dir("claude"))).toEqual(["research"]);
    expect(await agentsOf("coding")).toBeUndefined();
    expect(await listDir(hub.skillsDir)).toEqual(["research"]);
    expect((await readState(hub.statePath)).links.map((l) => path.basename(l.path))).toEqual(["research"]);

    expect(removedSkills).toHaveLength(1);
    expect(await hashSkillDir(removedSkills[0]!.backup!)).toBe(hashBefore);
  });

  it("also removes links the manifest stopped listing", async () => {
    const m = await readManifest(hub.manifestPath);
    m.skills.coding!.agents = ["claude"];
    await writeManifest(hub.manifestPath, m);

    await remove({ skills: ["coding"] });

    expect(await listDir(dir("cursor"))).toEqual([]);
    expect(await listDir(dir("agents"))).toEqual([]);
  });

  it("removes every skill with '*'", async () => {
    const { removedSkills } = await remove({ skills: ["*"] });
    expect(removedSkills.map((r) => r.skill)).toEqual(["coding", "research"]);
    expect(await listSkills(hub)).toEqual([]);
    expect(await listDir(dir("claude"))).toEqual([]);
  });
});

describe("remove safety", () => {
  it("--dry-run reports outcomes and changes nothing", async () => {
    const snapshot = async () => ({
      manifest: await fs.readFile(hub.manifestPath, "utf8"),
      state: await fs.readFile(hub.statePath, "utf8"),
      claude: await listDir(dir("claude")),
      hub: await listDir(hub.skillsDir),
      backups: await listDir(hub.backupsDir),
    });
    const before = await snapshot();

    const { links, removedSkills } = await remove({ skills: ["coding"], dryRun: true });

    expect(links.map((l) => l.outcome)).toEqual(["unlinked", "unlinked", "unlinked"]);
    expect(removedSkills).toEqual([{ skill: "coding" }]);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects skills that are not in the hub before changing anything", async () => {
    const err = await remove({ skills: ["coding", "nope"] }).catch((e: unknown) => e);
    expect((err as SkillsymError).code).toBe("SKILL_NOT_IN_HUB");
    expect(await listDir(hub.skillsDir)).toEqual(["coding", "research"]);
  });
});
