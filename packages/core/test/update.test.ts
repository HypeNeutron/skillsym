import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRemoteSkills,
  addRemoteUpstreams,
  addSkill,
  assignSkills,
  builtinAgents,
  hashSkillDir,
  markUpstreamsReviewed,
  openHub,
  parseRemoteTarget,
  planUpdate,
  readManifest,
  resolveUpdateConflicts,
  runGit,
  SkillsymError,
  updateSkills,
  type AgentProfile,
  type Hub,
} from "../src/index.js";
import { makeSkill, makeTempDir, removeDir } from "./helpers.js";

let root: string;
let userHome: string;
let hub: Hub;
let profiles: AgentProfile[];

beforeEach(async () => {
  root = await makeTempDir("skillsym-update-");
  userHome = path.join(root, "user");
  await fs.mkdir(path.join(userHome, ".claude"), { recursive: true });
  await fs.mkdir(path.join(userHome, ".gemini", "config"), { recursive: true });
  hub = await openHub(path.join(root, "hub"));
  profiles = builtinAgents(userHome);
});

afterEach(async () => {
  await removeDir(root);
});

async function initRepo(dir: string, skills: Record<string, Record<string, string>>): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  await runGit(["init", "-b", "main"], dir);
  await runGit(["config", "user.email", "test@skillsym.dev"], dir);
  await runGit(["config", "user.name", "SkillSym Test"], dir);
  for (const [name, extra] of Object.entries(skills)) {
    await makeSkill(path.join(dir, "skills"), name, extra);
  }
  await runGit(["add", "."], dir);
  await runGit(["commit", "-m", "v1"], dir);
  return (await runGit(["rev-parse", "HEAD"], dir)).trim();
}

async function commitRepo(dir: string, message: string): Promise<string> {
  await runGit(["add", "-A"], dir);
  await runGit(["commit", "-m", message], dir);
  return (await runGit(["rev-parse", "HEAD"], dir)).trim();
}

describe("updateSkills & planUpdate", () => {
  it("updates clean remote-tracked skills, backs up old versions, and updates manifest hashes/commits", async () => {
    const repoDir = path.join(root, "upstream");
    const c1 = await initRepo(repoDir, {
      alpha: { "notes.md": "v1\n" },
      beta: { "notes.md": "v1\n" },
    });
    const target = (await parseRemoteTarget(pathToFileURL(repoDir).toString(), root))!;
    await addRemoteSkills(hub, target, { profiles });
    await assignSkills(hub, { skills: ["alpha"], agents: ["claude", "antigravity"], profiles });

    await fs.writeFile(path.join(repoDir, "skills", "alpha", "notes.md"), "v2\n");
    const c2 = await commitRepo(repoDir, "update alpha to v2");

    const preview = await planUpdate(hub, { profiles });
    expect(preview.items.map((i) => [i.skill, i.status])).toEqual([
      ["alpha", "updated"],
      ["beta", "up-to-date"],
    ]);
    // Dry run did not modify hub copy yet.
    expect(await fs.readFile(path.join(hub.skillsDir, "alpha", "notes.md"), "utf8")).toBe("v1\n");

    const result = await updateSkills(hub, { profiles });
    const alphaItem = result.items.find((i) => i.skill === "alpha")!;
    expect(alphaItem).toMatchObject({ status: "updated", oldCommit: c1, newCommit: c2 });
    expect(alphaItem.backup).toBeTruthy();
    expect(await fs.readFile(path.join(alphaItem.backup!, "notes.md"), "utf8")).toBe("v1\n");
    expect(await fs.readFile(path.join(hub.skillsDir, "alpha", "notes.md"), "utf8")).toBe("v2\n");

    const manifest = await readManifest(hub.manifestPath);
    expect(manifest.skills["alpha"]?.remote?.commit).toBe(c2);
    expect(manifest.skills["alpha"]?.sourceHash).toBe(await hashSkillDir(path.join(hub.skillsDir, "alpha")));
  });

  it("keeps locally edited skills when upstream did not change, and flags conflict when both changed", async () => {
    const repoDir = path.join(root, "upstream");
    await initRepo(repoDir, { alpha: { "notes.md": "v1\n" } });
    const target = (await parseRemoteTarget(pathToFileURL(repoDir).toString(), root))!;
    await addRemoteSkills(hub, target, { profiles });

    // Only local edit so far -> upstream unchanged -> stays up-to-date without overwriting edits.
    await fs.writeFile(path.join(hub.skillsDir, "alpha", "notes.md"), "local custom\n");
    const noUpstreamChange = await updateSkills(hub, { profiles });
    expect(noUpstreamChange.items[0]?.status).toBe("up-to-date");
    expect(await fs.readFile(path.join(hub.skillsDir, "alpha", "notes.md"), "utf8")).toBe("local custom\n");

    // Now upstream also modifies alpha -> three-way conflict.
    await fs.writeFile(path.join(repoDir, "skills", "alpha", "notes.md"), "v2 upstream\n");
    const c2 = await commitRepo(repoDir, "v2");

    const res = await updateSkills(hub, { profiles });
    expect(res.items[0]?.status).toBe("conflict");
    expect(await fs.readFile(path.join(hub.skillsDir, "alpha", "notes.md"), "utf8")).toBe("local custom\n");

    // Resolve with keep leaves local copy untouched.
    const kept = await resolveUpdateConflicts(hub, [{ skill: "alpha", choice: "keep" }], { profiles });
    expect(kept).toEqual([{ skill: "alpha", choice: "keep", ok: true }]);
    expect(await fs.readFile(path.join(hub.skillsDir, "alpha", "notes.md"), "utf8")).toBe("local custom\n");

    // Resolve with overwrite backs up local edit and writes v2 upstream.
    const overwrote = await resolveUpdateConflicts(hub, [{ skill: "alpha", choice: "overwrite" }], { profiles });
    expect(overwrote[0]?.ok).toBe(true);
    expect(overwrote[0]?.backup).toBeTruthy();
    expect(await fs.readFile(path.join(overwrote[0]!.backup!, "notes.md"), "utf8")).toBe("local custom\n");
    expect(await fs.readFile(path.join(hub.skillsDir, "alpha", "notes.md"), "utf8")).toBe("v2 upstream\n");
    expect((await readManifest(hub.manifestPath)).skills["alpha"]?.remote?.commit).toBe(c2);
  });

  it("reports upstream-missing without deleting the hub skill when deleted upstream", async () => {
    const repoDir = path.join(root, "upstream");
    await initRepo(repoDir, { gone: { "notes.md": "v1\n" } });
    const target = (await parseRemoteTarget(pathToFileURL(repoDir).toString(), root))!;
    await addRemoteSkills(hub, target, { profiles });

    await fs.rm(path.join(repoDir, "skills", "gone"), { recursive: true, force: true });
    await commitRepo(repoDir, "remove gone skill");

    const res = await updateSkills(hub, { profiles });
    expect(res.items[0]?.status).toBe("upstream-missing");
    expect(await fs.readFile(path.join(hub.skillsDir, "gone", "notes.md"), "utf8")).toBe("v1\n");
  });

  it("updates skills added from a local git repository", async () => {
    const bare = path.join(root, "bare.git");
    await runGit(["init", "--bare", bare]);
    const localAuthor = path.join(root, "author");
    await initRepo(localAuthor, { localgit: { "body.md": "v1\n" } });
    await runGit(["remote", "add", "origin", pathToFileURL(bare).toString()], localAuthor);
    await runGit(["push", "-u", "origin", "main"], localAuthor);

    const localWorking = path.join(root, "working");
    await runGit(["clone", pathToFileURL(bare).toString(), localWorking]);
    await addSkill(hub, path.join(localWorking, "skills", "localgit"));

    // Push upstream commit via author clone so working clone pulls it during update.
    await fs.writeFile(path.join(localAuthor, "skills", "localgit", "body.md"), "v2 from bare\n");
    await commitRepo(localAuthor, "push v2");
    await runGit(["push", "origin", "main"], localAuthor);

    const updated = await updateSkills(hub, { profiles });
    expect(updated.items[0]?.status).toBe("updated");
    expect(await fs.readFile(path.join(hub.skillsDir, "localgit", "body.md"), "utf8")).toBe("v2 from bare\n");
  });

  it("handles --link remote updates without altering working files during dry-run", async () => {
    const repoDir = path.join(root, "upstream");
    await initRepo(repoDir, { linked: { "doc.md": "v1\n" } });
    const target = (await parseRemoteTarget(pathToFileURL(repoDir).toString(), root))!;
    await addRemoteSkills(hub, target, { link: true, profiles });

    await fs.writeFile(path.join(repoDir, "skills", "linked", "doc.md"), "v2\n");
    const c2 = await commitRepo(repoDir, "v2 linked");

    const dry = await planUpdate(hub, { profiles });
    expect(dry.items[0]).toMatchObject({ skill: "linked", status: "updated", newCommit: c2 });
    expect(await fs.readFile(path.join(hub.skillsDir, "linked", "doc.md"), "utf8")).toBe("v1\n");

    const applied = await updateSkills(hub, { profiles });
    expect(applied.items[0]?.status).toBe("updated");
    expect(await fs.readFile(path.join(hub.skillsDir, "linked", "doc.md"), "utf8")).toBe("v2\n");
  });

  it("throws SKILL_NOT_IN_HUB when explicitly asked to update an unknown skill", async () => {
    await addSkill(hub, await makeSkill(path.join(root, "local"), "real"));
    await expect(updateSkills(hub, { skills: ["nope"], profiles })).rejects.toThrow(SkillsymError);
  });

  it("lazy-backfills remote origin from .skill-lock.json during update and persists it", async () => {
    const repoDir = path.join(root, "upstream");
    await initRepo(repoDir, { locked: { "doc.md": "v1\n" } });
    const repoUrl = pathToFileURL(repoDir).toString();

    // Simulate a hub skill added from a stale local copy before `remote` tracking existed.
    const oldCopy = await makeSkill(path.join(root, "old"), "locked", { "doc.md": "v1\n" });
    await addSkill(hub, oldCopy);
    await fs.rm(oldCopy, { recursive: true, force: true });

    await fs.mkdir(path.join(userHome, ".agents"), { recursive: true });
    await fs.writeFile(
      path.join(userHome, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          locked: { source: "owner/repo", sourceType: "github", sourceUrl: repoUrl, skillPath: "skills/locked/SKILL.md" },
        },
      }),
    );

    await fs.writeFile(path.join(repoDir, "skills", "locked", "doc.md"), "v2 upstream\n");
    const c2 = await commitRepo(repoDir, "v2 locked");

    const preview = await planUpdate(hub, { profiles });
    expect(preview.items[0]).toMatchObject({ skill: "locked", status: "updated", remoteUrl: repoUrl, newCommit: c2 });
    expect((await readManifest(hub.manifestPath)).skills["locked"]?.remote).toBeUndefined();

    const applied = await updateSkills(hub, { profiles });
    expect(applied.items[0]).toMatchObject({ skill: "locked", status: "updated", newCommit: c2 });
    expect(await fs.readFile(path.join(hub.skillsDir, "locked", "doc.md"), "utf8")).toBe("v2 upstream\n");
    expect((await readManifest(hub.manifestPath)).skills["locked"]?.remote).toEqual({
      url: repoUrl,
      subpath: "skills/locked",
      commit: c2,
    });
  });

  it("reports local git repos without an origin remote as local-only when in sync with hub", async () => {
    const localRepo = path.join(root, "local-no-origin");
    await initRepo(localRepo, { localcraft: { "note.md": "v1\n" } });
    await addSkill(hub, path.join(localRepo, "skills", "localcraft"));

    const res = await planUpdate(hub, { profiles });
    expect(res.items[0]?.status).toBe("local-only");
    expect(res.items[0]?.reason).toContain("no origin remote");

    // If local files in that folder change relative to hub, update picks them up cleanly.
    await fs.writeFile(path.join(localRepo, "skills", "localcraft", "note.md"), "v2 local\n");
    const updated = await updateSkills(hub, { profiles });
    expect(updated.items[0]?.status).toBe("updated");
    expect(await fs.readFile(path.join(hub.skillsDir, "localcraft", "note.md"), "utf8")).toBe("v2 local\n");
  });

  it("watches orchestrator upstreams[] safely: diffs subpath commits without overwriting hub files, and advances baseline on mark-reviewed", async () => {
    const repoDir = path.join(root, "upstream");
    const c1 = await initRepo(repoDir, {
      watched: { "guide.md": "v1\n" },
      unrelated: { "guide.md": "v1\n" },
    });
    await addSkill(hub, await makeSkill(path.join(root, "orch"), "my-orchestrator", { "modules/flow.md": "adapted v1\n" }));
    const target = (await parseRemoteTarget(pathToFileURL(repoDir).toString(), root))!;
    await addRemoteUpstreams(hub, target, "my-orchestrator", { skills: ["watched"] });

    // Commit touching only `unrelated` should silently fast-forward commit without noisy `upstream-changed`.
    await fs.writeFile(path.join(repoDir, "skills", "unrelated", "guide.md"), "v2\n");
    const cUnrelated = await commitRepo(repoDir, "unrelated change");
    const quietCheck = await updateSkills(hub, { profiles });
    expect(quietCheck.items[0]?.status).toBe("up-to-date");
    expect((await readManifest(hub.manifestPath)).skills["my-orchestrator"]?.upstreams?.[0]?.commit).toBe(cUnrelated);

    // Commit touching `watched` emits `upstream-changed` with changed files and never edits hub orchestrator files.
    await fs.writeFile(path.join(repoDir, "skills", "watched", "guide.md"), "v2 upstream change\n");
    const c3 = await commitRepo(repoDir, "watched skill updated");

    const changedPlan = await updateSkills(hub, { profiles });
    expect(changedPlan.items[0]?.status).toBe("upstream-changed");
    expect(changedPlan.items[0]?.upstreamChanges).toEqual([
      expect.objectContaining({
        url: pathToFileURL(repoDir).toString(),
        subpath: "skills/watched",
        oldCommit: cUnrelated,
        newCommit: c3,
        changedFiles: ["M\tskills/watched/guide.md"],
      }),
    ]);
    // Hub orchestrator files and baseline commit remain untouched until reviewed.
    expect(await fs.readFile(path.join(hub.skillsDir, "my-orchestrator", "modules", "flow.md"), "utf8")).toBe("adapted v1\n");
    expect((await readManifest(hub.manifestPath)).skills["my-orchestrator"]?.upstreams?.[0]?.commit).toBe(cUnrelated);
    expect(cUnrelated).not.toBe(c1);

    await markUpstreamsReviewed(hub, [
      { skill: "my-orchestrator", choice: "mark-reviewed", changes: changedPlan.items[0]!.upstreamChanges },
    ]);
    expect((await readManifest(hub.manifestPath)).skills["my-orchestrator"]?.upstreams?.[0]?.commit).toBe(c3);

    const after = await planUpdate(hub, { profiles });
    expect(after.items[0]?.status).toBe("up-to-date");
  });
});
