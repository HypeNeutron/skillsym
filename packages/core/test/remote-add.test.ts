import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addLibrary,
  addRemoteSkills,
  addRemoteUpstreams,
  addSkill,
  assignSkills,
  builtinAgents,
  discoverSkillUpstreams,
  hashSkillDir,
  openHub,
  parseRemoteTarget,
  planLibraryAdd,
  planRemoteAdd,
  readManifest,
  runGit,
  SkillsymError,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { listDir, makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

beforeEach(async () => {
  root = await makeTempDir("skillsym-remote-add-");
  userHome = path.join(root, "user");
  await fs.mkdir(path.join(userHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(userHome, ".gemini", "config"), { recursive: true });
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
});

afterEach(async () => {
  await removeDir(root);
});

async function createUpstreamRepo(skills: Record<string, Record<string, string>>): Promise<{ dir: string; url: string; commit: string }> {
  const dir = path.join(root, "upstream");
  await fs.mkdir(dir, { recursive: true });
  await runGit(["init", "-b", "main"], dir);
  await runGit(["config", "user.email", "test@skillsym.dev"], dir);
  await runGit(["config", "user.name", "SkillSym Test"], dir);
  for (const [name, extra] of Object.entries(skills)) {
    await makeSkill(path.join(dir, "skills"), name, extra);
  }
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "initial skills"], dir);
  const commit = (await runGit(["rev-parse", "HEAD"], dir)).trim();
  return { dir, url: pathToFileURL(dir).toString(), commit };
}

describe("addRemoteSkills & library -s filter", () => {
  it("adds filtered skills from a remote repo, records remote metadata, and isolates subpaths", async () => {
    const repo = await createUpstreamRepo({
      "find-skills": { "ref.md": "v1\n" },
      "other-skill": { "ref.md": "v1\n" },
    });
    const target = (await parseRemoteTarget(repo.url, root))!;

    const dry = await planRemoteAdd(hub, target, { skills: ["find-skills"] });
    expect(dry.items.map((i) => [i.name, i.type])).toEqual([["find-skills", "add"]]);
    expect(await listDir(hub.skillsDir)).toEqual([]);

    const res = await addRemoteSkills(hub, target, { skills: ["find-skills"], profiles });
    expect(res.added.map((s) => s.name)).toEqual(["find-skills"]);
    expect(await listDir(hub.skillsDir)).toEqual(["find-skills"]);

    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills["find-skills"]?.mode).toBe("link");
    expect(manifest.skills["find-skills"]?.remote).toEqual({
      url: repo.url,
      subpath: "skills/find-skills",
      commit: repo.commit,
    });
    expect(manifest.skills["other-skill"]).toBeUndefined();

    // Direct subpath target picks only that folder.
    const subTarget = { ...(await parseRemoteTarget(repo.url, root))!, subpath: "skills/other-skill" };
    const subRes = await addRemoteSkills(hub, subTarget, { profiles });
    expect(subRes.added.map((s) => s.name)).toEqual(["other-skill"]);
  });

  it("supports --link against the cached remote checkout", async () => {
    const repo = await createUpstreamRepo({ alpha: { "doc.md": "v1\n" } });
    const target = (await parseRemoteTarget(repo.url, root))!;

    const res = await addRemoteSkills(hub, target, { link: true, profiles });
    expect(res.added[0]?.mode).toBe("source-link");
    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills["alpha"]?.mode).toBe("source-link");
    expect(manifest.skills["alpha"]?.remote?.commit).toBe(repo.commit);
    expect(manifest.libraries?.length).toBe(1);
  });

  it("attaches remote tracking to existing hub skills, keeping agents intact and guarding local edits", async () => {
    const repo = await createUpstreamRepo({
      clean: { "body.md": "v1\n" },
      identical: { "body.md": "same\n" },
      edited: { "body.md": "v1\n" },
    });

    // Populate hub before linking to remote.
    await addSkill(hub, await makeSkill(path.join(root, "local"), "identical", { "body.md": "same\n" }));
    await addSkill(hub, await makeSkill(path.join(root, "local"), "clean", { "body.md": "v1\n" }));
    await addSkill(hub, await makeSkill(path.join(root, "local"), "edited", { "body.md": "v1\n" }));
    await assignSkills(hub, { skills: ["identical", "clean", "edited"], agents: ["claude", "antigravity"], profiles });

    // Local user modifies `edited` inside hub; upstream advances `clean` and `edited`.
    await fs.writeFile(path.join(hub.skillsDir, "edited", "body.md"), "my custom edit\n");
    await fs.writeFile(path.join(repo.dir, "skills", "clean", "body.md"), "v2 upstream\n");
    await fs.writeFile(path.join(repo.dir, "skills", "edited", "body.md"), "v2 upstream\n");
    await runGit(["add", "."], repo.dir);
    await runGit(["commit", "-m", "v2"], repo.dir);
    const c2 = (await runGit(["rev-parse", "HEAD"], repo.dir)).trim();

    const target = (await parseRemoteTarget(repo.url, root))!;
    const result = await addRemoteSkills(hub, target, { profiles });
    const byName = Object.fromEntries(result.items.map((i) => [i.name, i]));

    expect(byName["identical"]?.type).toBe("adopt-remote");
    expect(byName["clean"]?.type).toBe("update");
    expect(byName["clean"]?.backup).toBeTruthy();
    expect(byName["edited"]?.type).toBe("conflict");

    const manifest = await readManifest(hub.manifestPath);
    // Agents preserved across all three outcomes!
    expect(manifest.skills["identical"]?.agents).toEqual(["antigravity", "claude"]);
    expect(manifest.skills["clean"]?.agents).toEqual(["antigravity", "claude"]);
    expect(manifest.skills["edited"]?.agents).toEqual(["antigravity", "claude"]);

    // Clean copy updated + hash refreshed; edited copy untouched; identical got remote metadata.
    expect(await fs.readFile(path.join(hub.skillsDir, "clean", "body.md"), "utf8")).toBe("v2 upstream\n");
    expect(manifest.skills["clean"]?.remote?.commit).toBe(c2);
    expect(manifest.skills["clean"]?.sourceHash).toBe(await hashSkillDir(path.join(hub.skillsDir, "clean")));
    expect(await fs.readFile(path.join(hub.skillsDir, "edited", "body.md"), "utf8")).toBe("my custom edit\n");
    expect(manifest.skills["edited"]?.remote?.commit).toBe(c2);
    expect(manifest.skills["identical"]?.remote?.commit).toBe(c2);
  });

  it("filters local libraries via -s / skills option and rejects missing literal names", async () => {
    const lib = path.join(root, "lib");
    await makeSkill(lib, "one");
    await makeSkill(lib, "two");

    const plan = await planLibraryAdd(hub, lib, { skills: ["one"] });
    expect(plan.items.map((i) => i.name)).toEqual(["one"]);

    await expect(planLibraryAdd(hub, lib, { skills: ["missing"] })).rejects.toThrow(SkillsymError);

    const added = await addLibrary(hub, lib, { skills: ["two"] });
    expect(added.added.map((s) => s.name)).toEqual(["two"]);
  });

  it("discovers nested _archive upstreams (ignoring NOTICE.md credits) and attaches --upstream without touching host files", async () => {
    const repo = await createUpstreamRepo({
      "grill-me": { "SKILL.md": "---\nname: grill-me\ndescription: x\n---\n" },
      "other": { "a.md": "v1\n" },
    });

    const hostSrc = await makeSkill(path.join(root, "orch"), "my-orchestrator", {
      "modules/intro.md": "custom orchestrator\n",
      "NOTICE.md": "Adapted from https://github.com/mattpocock/skills (MIT attribution only).\n",
      "_archive/nested/SKILL.md": "---\nname: nested\ndescription: x\nrepository: softaworks/agent-toolkit\nsubpath: skills/nested\n---\n",
    });

    const upstreams = await discoverSkillUpstreams("my-orchestrator", hostSrc);
    expect(upstreams).toEqual([
      { url: "https://github.com/softaworks/agent-toolkit.git", subpath: "skills/nested", commit: "" },
    ]);

    await addSkill(hub, await makeSkill(path.join(root, "plain-host"), "my-orch", { "modules/custom.md": "keep me\n" }));
    const target = (await parseRemoteTarget(repo.url, root))!;
    const attached = await addRemoteUpstreams(hub, target, "my-orch", { skills: ["grill-me"] });
    expect(attached.items).toEqual([{ url: repo.url, subpath: "skills/grill-me", commit: repo.commit, type: "added" }]);
    expect(await fs.readFile(path.join(hub.skillsDir, "my-orch", "modules", "custom.md"), "utf8")).toBe("keep me\n");

    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills["my-orch"]?.upstreams).toEqual([
      { url: repo.url, subpath: "skills/grill-me", commit: repo.commit },
    ]);
  });
});
