import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSkill, listSkills, openHub, readManifest, resolveHubHome, SkillsymError } from "../src/index.js";
import { isDirectory, isFile, isMissing } from "../src/fsutil.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let home: string;
let sources: string;

beforeEach(async () => {
  root = await makeTempDir();
  home = path.join(root, "hub");
  sources = path.join(root, "sources");
  await fs.mkdir(sources);
});

afterEach(async () => {
  await removeDir(root);
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SkillsymError);
  expect((err as SkillsymError).code).toBe(code);
}

describe("isMissing", () => {
  it("treats ENOENT and ENOTDIR as nothing there, and other errors as real errors", () => {
    expect(isMissing({ code: "ENOENT" })).toBe(true);
    expect(isMissing({ code: "ENOTDIR" })).toBe(true);
    expect(isMissing({ code: "EACCES" })).toBe(false);
  });

  it("says a path through a file does not exist", async () => {
    const file = path.join(root, "README.txt");
    await fs.writeFile(file, "x");
    expect(await isFile(path.join(file, "SKILL.md"))).toBe(false);
    expect(await isDirectory(path.join(file, "sub"))).toBe(false);
  });
});

describe("hub location", () => {
  it("uses SKILLSYM_HOME when set", () => {
    expect(resolveHubHome({ env: { SKILLSYM_HOME: home }, homedir: "/ignored" })).toBe(path.resolve(home));
  });

  it("defaults to ~/.skillsym", () => {
    expect(resolveHubHome({ env: {}, homedir: root })).toBe(path.join(root, ".skillsym"));
  });

  it("creates the hub and an empty v1 manifest on first open", async () => {
    const hub = await openHub(home);
    expect(await listDir(home)).toEqual(expect.arrayContaining(["backups", "manifest.json", "skills"]));
    expect(await readManifest(hub.manifestPath)).toEqual({ version: 1, skills: {} });
  });

  it("does not overwrite an existing manifest when reopened", async () => {
    const hub = await openHub(home);
    await addSkill(hub, await makeSkill(sources, "coding"));
    await openHub(home);
    expect(Object.keys((await readManifest(hub.manifestPath)).skills)).toEqual(["coding"]);
  });
});

describe("add + list", () => {
  it("copies the skill folder into the hub and records it", async () => {
    const hub = await openHub(home);
    const src = await makeSkill(sources, "research", { "refs/notes.md": "nested" });

    const added = await addSkill(hub, src);

    expect(added).toMatchObject({ name: "research", agents: [], mode: "link", scope: "user" });
    expect(await fs.readFile(path.join(hub.skillsDir, "research", "refs", "notes.md"), "utf8")).toBe("nested");
    expect(await listSkills(hub)).toEqual([
      { name: "research", path: path.join(hub.skillsDir, "research"), agents: [], mode: "link", scope: "user", source: src },
    ]);
    // The source is copied, not moved.
    expect(await listDir(src)).toEqual(["SKILL.md", "refs"]);
  });

  it("lists skills sorted by name", async () => {
    const hub = await openHub(home);
    await addSkill(hub, await makeSkill(sources, "zeta"));
    await addSkill(hub, await makeSkill(sources, "alpha"));
    expect((await listSkills(hub)).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });

  it("writes the manifest as UTF-8 without a BOM", async () => {
    const hub = await openHub(home);
    await addSkill(hub, await makeSkill(sources, "coding"));
    const bytes = await fs.readFile(hub.manifestPath);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("add refuses and changes nothing", () => {
  async function snapshot(hub: Awaited<ReturnType<typeof openHub>>) {
    return { manifest: await fs.readFile(hub.manifestPath, "utf8"), skills: await listDir(hub.skillsDir) };
  }

  it("when the folder has no SKILL.md", async () => {
    const hub = await openHub(home);
    const dir = path.join(sources, "empty");
    await fs.mkdir(dir);
    const before = await snapshot(hub);
    await expectCode(addSkill(hub, dir), "MISSING_SKILL_MD");
    expect(await snapshot(hub)).toEqual(before);
  });

  it("when the path does not exist", async () => {
    const hub = await openHub(home);
    await expectCode(addSkill(hub, path.join(sources, "nope")), "SKILL_NOT_FOUND_AT_PATH");
  });

  it("when a skill with the same name is already in the hub", async () => {
    const hub = await openHub(home);
    await addSkill(hub, await makeSkill(sources, "coding"));
    const before = await snapshot(hub);
    const other = await makeSkill(path.join(root, "elsewhere"), "coding");
    await expectCode(addSkill(hub, other), "SKILL_EXISTS");
    expect(await snapshot(hub)).toEqual(before);
  });

  it("when the folder name is not a valid skill name", async () => {
    const hub = await openHub(home);
    const before = await snapshot(hub);
    await expectCode(addSkill(hub, await makeSkill(sources, "has space")), "INVALID_SKILL_NAME");
    expect(await snapshot(hub)).toEqual(before);
  });

  it("when the manifest has a version this build does not know, leaving the file untouched", async () => {
    const hub = await openHub(home);
    const future = JSON.stringify({ version: 99, skills: { keep: { agents: ["claude"] } } });
    await fs.writeFile(hub.manifestPath, future);
    await expectCode(addSkill(hub, await makeSkill(sources, "coding")), "UNSUPPORTED_MANIFEST_VERSION");
    await expectCode(listSkills(hub), "UNSUPPORTED_MANIFEST_VERSION");
    expect(await fs.readFile(hub.manifestPath, "utf8")).toBe(future);
    expect(await listDir(hub.skillsDir)).toEqual([]);
  });

  it("when the manifest is not valid JSON, leaving the file untouched", async () => {
    const hub = await openHub(home);
    await fs.writeFile(hub.manifestPath, "{ broken");
    await expectCode(addSkill(hub, await makeSkill(sources, "coding")), "MANIFEST_CORRUPT");
    expect(await fs.readFile(hub.manifestPath, "utf8")).toBe("{ broken");
  });
});

describe("hub lock", () => {
  it("times out while a live process holds the lock and changes nothing", async () => {
    const hub = await openHub(home);
    await fs.writeFile(hub.lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const src = await makeSkill(sources, "coding");
    await expectCode(addSkill(hub, src, { lock: { timeoutMs: 200 } }), "LOCK_TIMEOUT");
    expect(await listSkills(hub)).toEqual([]);
    expect(await listDir(hub.skillsDir)).toEqual([]);
  });

  it("reclaims a lock left behind by a process that has exited", async () => {
    const hub = await openHub(home);
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    await fs.writeFile(hub.lockPath, JSON.stringify({ pid: Number(dead.stdout), createdAt: new Date().toISOString() }));
    await addSkill(hub, await makeSkill(sources, "coding"), { lock: { timeoutMs: 2_000 } });
    expect((await listSkills(hub)).map((s) => s.name)).toEqual(["coding"]);
  });

  it("releases the lock after a failed add", async () => {
    const hub = await openHub(home);
    await addSkill(hub, await makeSkill(sources, "coding"));
    await expectCode(addSkill(hub, await makeSkill(path.join(root, "dup"), "coding")), "SKILL_EXISTS");
    expect(await listDir(home)).not.toContain(".lock");
  });
});
