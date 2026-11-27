import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSkill,
  assignSkills,
  builtinAgents,
  filterStatus,
  hashSkillDir,
  listUnregisteredSkills,
  openHub,
  planUpdate,
  readLinkTarget,
  readManifest,
  registerHubSkill,
  runGit,
  scanStatus,
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
});

afterEach(async () => {
  await removeDir(root);
});

const scan = () => scanStatus(hub, { profiles });

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillsymError);
  expect((err as SkillsymError).code).toBe(code);
}

/** A hub folder whose SKILL.md names the skill `declared`. */
async function makeMismatched(folder: string, declared: string) {
  const dir = await makeSkill(hub.skillsDir, folder);
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${declared}\ndescription: x\n---\n`);
  return dir;
}

describe("unregistered hub skills", () => {
  it("reports a hub folder with SKILL.md that is not in the manifest, and the report is not clean", async () => {
    const dir = await makeSkill(hub.skillsDir, "foo");
    const report = await scan();
    expect(report.unregistered).toEqual([{ name: "foo", path: dir }]);
    expect(report.clean).toBe(false);
  });

  it("is clean again once nothing is unregistered", async () => {
    expect((await scan()).clean).toBe(true);
    await addSkill(hub, await makeSkill(path.join(root, "src"), "bar"));
    expect((await scan()).unregistered).toEqual([]);
  });

  it("ignores loose files, dot and tmp folders, folders without SKILL.md, and invalid names", async () => {
    await fs.writeFile(path.join(hub.skillsDir, "bundle.zip"), "zip");
    await fs.writeFile(path.join(hub.skillsDir, "loose"), "file");
    await makeSkill(hub.skillsDir, ".hidden");
    await makeSkill(hub.skillsDir, "tmp-half");
    await fs.mkdir(path.join(hub.skillsDir, "empty-folder"));
    await fs.writeFile(path.join(hub.skillsDir, "empty-folder", "notes.md"), "x");
    await makeSkill(hub.skillsDir, "bad name");
    await makeSkill(hub.skillsDir, "trailing.");
    expect((await scan()).unregistered).toEqual([]);
  });

  it("reports a name: that differs from the folder as name-mismatch and never registers it", async () => {
    await makeMismatched("foo", "bar");
    const report = await scan();
    expect(report.unregistered).toMatchObject([{ name: "foo", reason: "name-mismatch" }]);
    expect(report.clean).toBe(false);
    await expectCode(registerHubSkill(hub, "foo"), "SKILL_NAME_MISMATCH");
    expect((await readManifest(hub.manifestPath)).skills.foo).toBeUndefined();
  });

  it("registers in place with the entry add writes: mode link, hash, no copy", async () => {
    const dir = await makeSkill(hub.skillsDir, "foo", { "refs/a.md": "A" });
    const info = await registerHubSkill(hub, "foo");
    expect(info).toMatchObject({ name: "foo", path: dir, agents: [], mode: "link" });
    const entry = (await readManifest(hub.manifestPath)).skills.foo!;
    expect(entry).toMatchObject({ agents: [], mode: "link", scope: "user", sourceHash: await hashSkillDir(dir) });
    expect((await scan()).unregistered).toEqual([]);
    expect(await fs.readFile(path.join(dir, "refs", "a.md"), "utf8")).toBe("A");
  });

  it("lists nothing for a folder already in the manifest and for a missing skills folder", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "src"), "bar"));
    expect(await listUnregisteredSkills(hub, await readManifest(hub.manifestPath))).toEqual([]);
    await fs.rm(hub.skillsDir, { recursive: true });
    expect(await listUnregisteredSkills(hub, await readManifest(hub.manifestPath))).toEqual([]);
  });

  it("filterStatus accepts the name of an unregistered hub skill", async () => {
    await makeSkill(hub.skillsDir, "foo");
    const report = await scan();
    await expect(filterStatus(hub, report, { profiles, skills: ["foo"] })).resolves.toBeDefined();
    await expectCode(filterStatus(hub, report, { profiles, skills: ["nope"] }), "SKILL_NOT_IN_HUB");
  });

  it("records no source, so a hub that is a git repo is not taken for the skill's origin", async () => {
    await runGit(["init", "-b", "main"], hub.home);
    await runGit(["config", "user.email", "test@skillsym.dev"], hub.home);
    await runGit(["config", "user.name", "SkillSym Test"], hub.home);
    await makeSkill(hub.skillsDir, "foo");
    await runGit(["add", "."], hub.home);
    await runGit(["commit", "-m", "v1"], hub.home);
    await registerHubSkill(hub, "foo");
    expect((await readManifest(hub.manifestPath)).skills.foo).not.toHaveProperty("source");
    const plan = await planUpdate(hub, { profiles, fetch: false });
    expect(plan.items.filter((i) => i.skill === "foo" && i.status !== "local-only")).toEqual([]);
  });

  describe("assign", () => {
    it("registers an unregistered hub folder, then links it", async () => {
      await makeSkill(hub.skillsDir, "foo");
      const { results } = await assignSkills(hub, { skills: ["foo"], agents: ["claude"], profiles });
      const link = path.join(userHome, ".claude", "skills", "foo");
      expect(results).toEqual([{ skill: "foo", agents: ["claude"], path: link, outcome: "linked" }]);
      expect(await readLinkTarget(link)).toBe(path.join(hub.skillsDir, "foo"));
      const entry = (await readManifest(hub.manifestPath)).skills.foo!;
      expect(entry).toMatchObject({ agents: ["claude"], mode: "link", sourceHash: await hashSkillDir(path.join(hub.skillsDir, "foo")) });
    });

    it("refuses a name-mismatch folder with a clear error and registers nothing", async () => {
      await makeMismatched("foo", "bar");
      await expectCode(assignSkills(hub, { skills: ["foo"], agents: ["claude"], profiles }), "SKILL_NAME_MISMATCH");
      expect((await readManifest(hub.manifestPath)).skills.foo).toBeUndefined();
    });

    it("keeps SKILL_NOT_IN_HUB for names that are not hub folders", async () => {
      await fs.mkdir(path.join(hub.skillsDir, "no-skill-md"));
      await expectCode(assignSkills(hub, { skills: ["nothing"], agents: ["claude"], profiles }), "SKILL_NOT_IN_HUB");
      await expectCode(assignSkills(hub, { skills: ["no-skill-md"], agents: ["claude"], profiles }), "SKILL_NOT_IN_HUB");
    });

    it("'*' registers valid unregistered folders and skips name-mismatch ones", async () => {
      await makeSkill(hub.skillsDir, "foo");
      await makeMismatched("odd", "other");
      await assignSkills(hub, { skills: ["*"], agents: ["claude"], profiles });
      const manifest = await readManifest(hub.manifestPath);
      expect(Object.keys(manifest.skills)).toEqual(["foo"]);
    });
  });
});
