import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  eject,
  hashSkillDir,
  openHub,
  readLinkTarget,
  readManifest,
  readState,
  scanStatus,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];
let original: string;

const claude = (skill = "coding") => path.join(userHome, ".claude", "skills", skill);
const agentsDir = (skill = "coding") => path.join(userHome, ".agents", "skills", skill);

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "refs/a.md": "A" }));
  await addSkill(hub, await makeSkill(path.join(root, "src"), "research"));
  await assignSkills(hub, { skills: ["coding"], agents: ["claude", "codex", "cursor"], profiles });
  await assignSkills(hub, { skills: ["research"], agents: ["claude"], profiles });
  original = await hashSkillDir(path.join(hub.skillsDir, "coding"));
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

describe("eject", () => {
  it("replaces every skillsym link with a real copy and clears skillsym's records", async () => {
    const { results } = await eject(hub);

    expect(results.map((r) => `${r.skill}:${r.outcome}`).sort()).toEqual(["coding:ejected", "coding:ejected", "research:ejected"]);
    for (const p of [claude(), agentsDir(), claude("research")]) expect(await readLinkTarget(p)).toBeNull();
    expect(await hashSkillDir(claude())).toBe(original);
    expect(await hashSkillDir(agentsDir())).toBe(original);
    expect((await readState(hub.statePath)).links).toEqual([]);

    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills.coding!.agents).toEqual([]);
    const report = await scanStatus(hub, { profiles });
    expect(report.clean).toBe(true);
    expect(report.unmanaged.map((u) => u.name).sort()).toEqual(["coding", "coding", "research"]);
  });

  it("leaves agents working after the hub is deleted", async () => {
    await eject(hub);
    await fs.rm(hub.home, { recursive: true });

    expect(await hashSkillDir(claude())).toBe(original);
    expect(await hashSkillDir(agentsDir())).toBe(original);
    expect(await fs.readFile(path.join(claude(), "refs", "a.md"), "utf8")).toBe("A");
  });

  it("keeps the hub itself", async () => {
    await eject(hub);
    expect(await listDir(hub.skillsDir)).toEqual(["coding", "research"]);
  });

  it("leaves a folder that replaced our link alone", async () => {
    await removeLink(claude());
    await makeSkill(path.join(userHome, ".claude", "skills"), "coding", { "theirs.md": "keep" });
    const { results } = await eject(hub);
    expect(results.find((r) => r.path === claude())!.outcome).toBe("left-in-place");
    expect(await fs.readFile(path.join(claude(), "theirs.md"), "utf8")).toBe("keep");
  });

  it("forgets links that are already gone", async () => {
    await removeLink(claude());
    const { results } = await eject(hub);
    expect(results.find((r) => r.path === claude())!.outcome).toBe("missing");
    expect((await readState(hub.statePath)).links).toEqual([]);
  });

  it("uses the hub's current copy when the link points at where the hub used to be", async () => {
    const moved = path.join(root, "hub-moved");
    await fs.rename(hub.home, moved);
    hub = await openHub(moved);
    const { results } = await eject(hub);
    expect(results.every((r) => r.outcome === "ejected")).toBe(true);
    expect(await hashSkillDir(claude())).toBe(original);
  });

  it("leaves a link alone when the hub has nothing to copy", async () => {
    await fs.rm(path.join(hub.skillsDir, "research"), { recursive: true });
    const { results } = await eject(hub);
    expect(results.find((r) => r.skill === "research")!.outcome).toBe("hub-missing");
    expect((await readState(hub.statePath)).links.map((l) => l.skill)).toEqual(["research"]);
  });

  it("--dry-run reports the same outcomes and changes nothing", async () => {
    const before = { state: await fs.readFile(hub.statePath, "utf8"), claude: await readLinkTarget(claude()) };
    const preview = await eject(hub, { dryRun: true });
    expect({ state: await fs.readFile(hub.statePath, "utf8"), claude: await readLinkTarget(claude()) }).toEqual(before);
    const done = await eject(hub);
    expect(done.results.map((r) => r.outcome)).toEqual(preview.results.map((r) => r.outcome));
  });

  it("can be run again: cleans half-made copies, and a second eject has nothing to do", async () => {
    const stale = path.join(userHome, ".claude", "skills", ".skillsym-eject-deadbeef");
    await fs.mkdir(stale, { recursive: true });
    await fs.writeFile(path.join(stale, "partial.md"), "x");

    await eject(hub);

    expect(await listDir(path.join(userHome, ".claude", "skills"))).toEqual(["coding", "research"]);
    expect((await eject(hub)).results).toEqual([]);
  });
});
