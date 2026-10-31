import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  abortImport,
  addSkill,
  builtinAgents,
  continueImport,
  hashSkillDir,
  importSkills,
  openHub,
  planImport,
  readLinkTarget,
  readManifest,
  readPendingImport,
  resolveImportConflicts,
  scanStatus,
  SkillsymError,
  type AgentProfile,
  type Hub,
  type ImportDecision,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

const claude = () => path.join(userHome, ".claude", "skills");
const agentsDir = () => path.join(userHome, ".agents", "skills");
const hubSkill = (name = "coding") => path.join(hub.skillsDir, name);
const claudeCopy = () => path.join(claude(), "coding");
const codexCopy = () => path.join(agentsDir(), "coding");

beforeEach(async () => {
  root = await makeTempDir();
  userHome = path.join(root, "user");
  await fs.mkdir(userHome);
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
  await makeSkill(claude(), "coding", { "a.md": "intro\nclaude line\noutro\n", "only-claude.md": "c" });
  await makeSkill(agentsDir(), "coding", { "a.md": "intro\ncodex line\noutro\n" });
});

afterEach(async () => {
  await removeDir(root);
});

const decide = (decisions: ImportDecision[]) => resolveImportConflicts(hub, decisions, { profiles });
const statuses = async () => (await scanStatus(hub, { profiles })).entries.map((e) => `${e.skill}:${e.agents.join("+")}:${e.status}`);

async function expectCode(promise: Promise<unknown>, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillsymError);
  expect((err as SkillsymError).code).toBe(code);
}

it("the setup is a conflict that plain import leaves alone", async () => {
  expect((await importSkills(hub, { profiles })).items.map((i) => i.type)).toEqual(["conflict"]);
  expect(await listDir(hub.skillsDir)).toEqual([]);
});

describe("primary", () => {
  it("keeps the chosen copy as the hub version and links every agent to it", async () => {
    const claudeHash = await hashSkillDir(claudeCopy());
    const [r] = await decide([{ name: "coding", choice: "primary", primary: claudeCopy() }]);

    expect(r).toMatchObject({ ok: true });
    expect(r!.backups).toHaveLength(2);
    expect(await hashSkillDir(hubSkill())).toBe(claudeHash);
    expect(await readLinkTarget(claudeCopy())).toBe(hubSkill());
    expect(await readLinkTarget(codexCopy())).toBe(hubSkill());
    expect(await statuses()).toEqual(["coding:claude:synced", "coding:codex+universal:synced"]);
  });

  it("can keep the hub's version over the agents' copies", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "hub.md": "h" }));
    const hubHash = await hashSkillDir(hubSkill());

    await decide([{ name: "coding", choice: "primary", primary: hubSkill() }]);

    expect(await hashSkillDir(hubSkill())).toBe(hubHash);
    expect(await readLinkTarget(claudeCopy())).toBe(hubSkill());
  });

  it("needs to know which version to keep", async () => {
    const [r] = await decide([{ name: "coding", choice: "primary" }]);
    expect(r!.ok).toBe(false);
    expect(await readLinkTarget(claudeCopy())).toBeNull();
  });
});

describe("keep-both", () => {
  it("keeps each version as its own skill, linked under its own name", async () => {
    const [r] = await decide([{ name: "coding", choice: "keep-both" }]);

    expect(r).toMatchObject({ ok: true, newSkills: ["coding-codex"] });
    expect(await listDir(hub.skillsDir)).toEqual(["coding", "coding-codex"]);
    expect(await readLinkTarget(claudeCopy())).toBe(hubSkill("coding"));
    expect(await readLinkTarget(path.join(agentsDir(), "coding-codex"))).toBe(hubSkill("coding-codex"));
    expect(await listDir(agentsDir())).toEqual(["coding-codex"]);

    const m = await readManifest(hub.manifestPath);
    expect(m.skills.coding!.agents).toEqual(["claude"]);
    expect(m.skills["coding-codex"]!.agents).toEqual(["codex", "universal"]);
    expect(await statuses()).toEqual(["coding:claude:synced", "coding-codex:codex+universal:synced"]);
  });
});

describe("merge", () => {
  it("writes a merge with markers only where the copies differ, and leaves the copies untouched", async () => {
    const [r] = await decide([{ name: "coding", choice: "merge" }]);

    expect(r).toMatchObject({ ok: true, conflictedFiles: ["a.md"] });
    const merged = await fs.readFile(path.join(r!.mergeDir!, "a.md"), "utf8");
    expect(merged).toBe("intro\n<<<<<<< claude\nclaude line\n======= codex\ncodex line\n>>>>>>>\noutro\n");
    expect(await fs.readFile(path.join(r!.mergeDir!, "only-claude.md"), "utf8")).toBe("c");
    expect(await readPendingImport(hub)).toMatchObject({ skill: "coding" });
    expect(await readLinkTarget(claudeCopy())).toBeNull();
    expect(await listDir(hub.skillsDir)).toEqual([]);
  });

  it("--continue refuses while markers remain, then finishes once they are resolved", async () => {
    const [r] = await decide([{ name: "coding", choice: "merge" }]);
    await expectCode(continueImport(hub, { profiles }), "MERGE_UNRESOLVED");

    await fs.writeFile(path.join(r!.mergeDir!, "a.md"), "intro\nclaude line\ncodex line\noutro\n");
    const done = await continueImport(hub, { profiles });

    expect(done.ok).toBe(true);
    expect(done.backups).toHaveLength(2);
    expect(await fs.readFile(path.join(hubSkill(), "a.md"), "utf8")).toBe("intro\nclaude line\ncodex line\noutro\n");
    expect(await readLinkTarget(claudeCopy())).toBe(hubSkill());
    expect(await readLinkTarget(codexCopy())).toBe(hubSkill());
    expect(await readPendingImport(hub)).toBeNull();
    expect(await listDir(path.join(hub.home, "merge"))).toEqual([]);
    expect(await statuses()).toEqual(["coding:claude:synced", "coding:codex+universal:synced"]);
  });

  it("--continue backs up the hub's old version when merging with it", async () => {
    await fs.rm(codexCopy(), { recursive: true });
    await addSkill(hub, await makeSkill(path.join(root, "src"), "coding", { "a.md": "intro\nhub line\noutro\n" }));
    const [r] = await decide([{ name: "coding", choice: "merge" }]);
    expect(await fs.readFile(path.join(r!.mergeDir!, "a.md"), "utf8")).toContain("<<<<<<< hub");

    await fs.writeFile(path.join(r!.mergeDir!, "a.md"), "merged\n");
    const done = await continueImport(hub, { profiles });

    const hubBackup = done.backups.find((b) => b.split(path.sep).includes("hub"));
    expect(await fs.readFile(path.join(hubBackup!, "a.md"), "utf8")).toBe("intro\nhub line\noutro\n");
    expect(await fs.readFile(path.join(hubSkill(), "a.md"), "utf8")).toBe("merged\n");
  });

  it("--continue refuses if an agent's copy changed since the merge started", async () => {
    const [r] = await decide([{ name: "coding", choice: "merge" }]);
    await fs.writeFile(path.join(r!.mergeDir!, "a.md"), "resolved\n");
    await fs.writeFile(path.join(claudeCopy(), "late-edit.md"), "x");
    await expectCode(continueImport(hub, { profiles }), "IMPORT_SOURCE_CHANGED");
    expect(await readLinkTarget(claudeCopy())).toBeNull();
  });

  it("--abort drops the merge and everything is as before", async () => {
    const before = [await hashSkillDir(claudeCopy()), await hashSkillDir(codexCopy())];
    const [r] = await decide([{ name: "coding", choice: "merge" }]);

    expect(await abortImport(hub)).toEqual({ skill: "coding" });

    expect(await readPendingImport(hub)).toBeNull();
    await expect(fs.stat(r!.mergeDir!)).rejects.toThrow();
    expect([await hashSkillDir(claudeCopy()), await hashSkillDir(codexCopy())]).toEqual(before);
    expect((await planImport(hub, { profiles })).items.map((i) => i.type)).toEqual(["conflict"]);
  });

  it("allows only one open merge at a time", async () => {
    await makeSkill(claude(), "other", { "x.md": "1" });
    await makeSkill(agentsDir(), "other", { "x.md": "2" });
    const results = await decide([
      { name: "coding", choice: "merge" },
      { name: "other", choice: "merge" },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]!.error).toMatch(/finish or abort/);
  });

  it("binary files that differ: --continue waits until only one version of each is left", async () => {
    await fs.writeFile(path.join(claudeCopy(), "img.bin"), Buffer.from([0, 1, 2, 3]));
    await fs.writeFile(path.join(codexCopy(), "img.bin"), Buffer.from([0, 9, 9, 9]));
    const [r] = await decide([{ name: "coding", choice: "merge" }]);
    expect(r!.binaryConflicts).toEqual([{ file: "img.bin", kept: "claude", extras: ["img.bin.codex"] }]);
    await fs.writeFile(path.join(r!.mergeDir!, "a.md"), "resolved\n");

    const err = await continueImport(hub, { profiles }).catch((e: unknown) => e);
    expect((err as SkillsymError).code).toBe("MERGE_UNRESOLVED");
    expect((err as SkillsymError).details.binaryLeftovers).toEqual(["img.bin.codex"]);
    expect((err as SkillsymError).message).toMatch(/--abort/);

    // Keep the Codex version: replace the original name with it and remove the extra.
    await fs.rm(path.join(r!.mergeDir!, "img.bin"));
    await fs.rename(path.join(r!.mergeDir!, "img.bin.codex"), path.join(r!.mergeDir!, "img.bin"));
    await continueImport(hub, { profiles });

    expect([...(await fs.readFile(path.join(hubSkill(), "img.bin")))]).toEqual([0, 9, 9, 9]);
    expect(await listDir(hubSkill())).not.toContain("img.bin.codex");
  });

  it("continue and abort report when there is no open merge", async () => {
    await expectCode(continueImport(hub, { profiles }), "NO_PENDING_IMPORT");
    await expectCode(abortImport(hub), "NO_PENDING_IMPORT");
  });
});

it("skip changes nothing", async () => {
  const [r] = await decide([{ name: "coding", choice: "skip" }]);
  expect(r!.ok).toBe(true);
  expect(await listDir(hub.skillsDir)).toEqual([]);
  expect(await readLinkTarget(claudeCopy())).toBeNull();
});
