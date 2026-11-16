import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { builtinAgents, type AgentProfile } from "./agents.js";
import { backupStamp } from "./backup.js";
import { SkillsymError } from "./errors.js";
import { isDirectory, isFile, pathExists, renameWithRetry } from "./fsutil.js";
import { hashSkillDir } from "./hash.js";
import type { Hub } from "./hub.js";
import { filterLibrarySkills, findLibrarySkills, isInGit } from "./library.js";
import { createDirLink } from "./links.js";
import { withLock, type LockOptions } from "./lock.js";
import { readManifest, writeManifest, type RemoteSkillInfo } from "./manifest.js";
import { copyIntoHub, isValidSkillName, replaceHubSkillFromSource, type SkillInfo } from "./skills.js";
import { refreshSkillsJsonManifests } from "./skills-json.js";
import { refreshLibrarySnapshots } from "./snapshots.js";
import { samePath } from "./state.js";

const execFileAsync = promisify(execFile);

export interface ParsedRemoteTarget {
  /** Normalized git clone URL (https, ssh, git, file, etc.). */
  url: string;
  /** Human-friendly label, e.g. "owner/repo". */
  label: string;
  /** Safe folder name under `<hub>/remotes/`. */
  slug: string;
  /** Optional branch, tag, or commit ref. */
  ref?: string;
  /** POSIX-normalized relative subpath inside the repository ("" for repo root). */
  subpath: string;
}

export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

export interface RemoteSyncOptions {
  git?: GitRunner;
  /** Set false to read an already-cached checkout without contacting upstream. */
  fetch?: boolean;
}

export interface RemoteSyncResult {
  repoDir: string;
  commit: string;
}

export interface LocalGitSource {
  root: string;
  url?: string;
  commit: string;
  subpath: string;
}

const SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@([A-Za-z0-9_./-]+))?$/;
const SSH_RE = /^(git@[^:]+):([^#]+?)(?:\.git)?(?:#(.+))?$/;

function safeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "remote";
}

/** Deterministic folder name under `<hub>/remotes/` for a repository and optional ref. */
export function slugForRemote(url: string, ref?: string): string {
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
  const match = gh ?? ssh;
  let base: string;
  if (match) {
    base = `${safeSegment(match[1]!)}--${safeSegment(match[2]!)}`;
  } else {
    const clean = url.replace(/[#?].*$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    const tail = safeSegment(path.posix.basename(clean) || "repo");
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 8);
    base = `${tail}-${hash}`;
  }
  return ref ? `${base}--${safeSegment(ref)}` : base;
}

/** Convert OS relative paths to canonical POSIX format for manifest metadata. */
export function toPosixPath(p: string): string {
  const normalized = p.split(path.sep).join("/");
  return normalized === "." ? "" : normalized;
}

/**
 * Parse a remote repository or GitHub target (`owner/repo`, `owner/repo@ref`,
 * `https://github.com/owner/repo/tree/ref/subpath`, `git@github.com:owner/repo.git`, `file://...`).
 * Returns `null` for local filesystem paths (including when a local path matches `owner/repo`).
 */
export async function parseRemoteTarget(input: string, cwd: string = process.cwd()): Promise<ParsedRemoteTarget | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Existing local paths on disk always take priority over GitHub shorthand.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !trimmed.startsWith("git@")) {
    if (await pathExists(path.resolve(cwd, trimmed))) return null;
  }

  return parseRemoteSpec(trimmed);
}

/** Pure parser for GitHub/git specifiers without local filesystem disambiguation. */
function parseRemoteSpec(trimmed: string): ParsedRemoteTarget | null {

  // SSH shorthand: git@host:owner/repo(.git)(#ref)
  const sshMatch = SSH_RE.exec(trimmed);
  if (sshMatch) {
    const hostPart = sshMatch[1]!;
    const repoPath = sshMatch[2]!.replace(/^\/+/, "");
    const ref = sshMatch[3]?.trim() || undefined;
    if (!repoPath.includes("/")) {
      throw new SkillsymError("REMOTE_INVALID", `Invalid git SSH target "${trimmed}". Expected git@host:owner/repo.git.`, { target: trimmed });
    }
    const normalizedRepo = repoPath.endsWith(".git") ? repoPath : `${repoPath}.git`;
    const url = `${hostPart}:${normalizedRepo}`;
    const label = repoPath;
    return { url, label, slug: slugForRemote(url, ref), ...(ref ? { ref } : {}), subpath: "" };
  }

  // URL forms: https://, http://, ssh://, git+https://, file://
  if (/^(?:git\+)?(?:https?|ssh|file):\/\//i.test(trimmed)) {
    const cleanInput = trimmed.replace(/^git\+/i, "");
    let parsed: URL;
    try {
      parsed = new URL(cleanInput);
    } catch {
      throw new SkillsymError("REMOTE_INVALID", `Invalid remote URL: "${trimmed}".`, { target: trimmed });
    }
    const hashRef = parsed.hash ? decodeURIComponent(parsed.hash.slice(1)).trim() || undefined : undefined;
    parsed.hash = "";

    if (parsed.protocol !== "file:" && parsed.hostname.toLowerCase() === "github.com") {
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length < 2) {
        throw new SkillsymError("REMOTE_INVALID", `GitHub URL must include owner and repository: "${trimmed}".`, { target: trimmed });
      }
      const owner = parts[0]!;
      const repo = parts[1]!.replace(/\.git$/i, "");
      if (!owner || !repo) {
        throw new SkillsymError("REMOTE_INVALID", `GitHub URL must include owner and repository: "${trimmed}".`, { target: trimmed });
      }
      let ref = hashRef;
      let subpath = "";
      if (parts.length > 2) {
        if (parts[2] === "tree") {
          if (!parts[3]) {
            throw new SkillsymError("REMOTE_INVALID", `GitHub /tree/ URL is missing a branch or tag: "${trimmed}".`, { target: trimmed });
          }
          ref = decodeURIComponent(parts[3]);
          subpath = parts.slice(4).map((s) => decodeURIComponent(s)).join("/");
        } else if (parts[2] === "blob") {
          throw new SkillsymError(
            "REMOTE_INVALID",
            `Point to a repository or skill folder (/tree/<ref>/...), not a file (/blob/...): "${trimmed}".`,
            { target: trimmed },
          );
        } else {
          throw new SkillsymError("REMOTE_INVALID", `Unsupported GitHub URL path in "${trimmed}". Use owner/repo or .../tree/<ref>/<subpath>.`, { target: trimmed });
        }
      }
      const url = `https://github.com/${owner}/${repo}.git`;
      return {
        url,
        label: `${owner}/${repo}`,
        slug: slugForRemote(url, ref),
        ...(ref ? { ref } : {}),
        subpath,
      };
    }

    const baseUrl = parsed.toString();
    const label = parsed.pathname.replace(/\.git$/i, "").replace(/^\/+/, "") || baseUrl;
    return {
      url: baseUrl,
      label,
      slug: slugForRemote(baseUrl, hashRef),
      ...(hashRef ? { ref: hashRef } : {}),
      subpath: "",
    };
  }

  // GitHub shorthand: owner/repo(@ref) — avoid Windows drives, relative paths, and home paths.
  if (
    !trimmed.startsWith(".") &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("~") &&
    !trimmed.includes("\\") &&
    !/^[A-Za-z]:/.test(trimmed)
  ) {
    const shortMatch = SHORTHAND_RE.exec(trimmed);
    if (shortMatch) {
      const owner = shortMatch[1]!;
      const repo = shortMatch[2]!;
      const ref = shortMatch[3]?.trim() || undefined;
      const url = `https://github.com/${owner}/${repo}.git`;
      return {
        url,
        label: `${owner}/${repo}`,
        slug: slugForRemote(url, ref),
        ...(ref ? { ref } : {}),
        subpath: "",
      };
    }
  }

  return null;
}

/** Run git non-interactively (`GIT_TERMINAL_PROMPT=0`) with structured `REMOTE_FETCH_FAILED` errors. */
export async function runGit(args: string[], cwd?: string): Promise<string> {
  const fullArgs = [
    "-c",
    "protocol.file.allow=always",
    "-c",
    "core.fsmonitor=false",
    ...(cwd ? ["-c", `safe.directory=${cwd.replace(/\\/g, "/")}`] : []),
    ...args,
  ];
  try {
    const { stdout } = await execFileAsync("git", fullArgs, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: string };
    const detail = e.stderr?.trim() || e.message || "git command failed";
    if (e.code === "ENOENT") {
      throw new SkillsymError("REMOTE_FETCH_FAILED", "Git is not installed or not on PATH; git is required for remote skills.", { args });
    }
    throw new SkillsymError("REMOTE_FETCH_FAILED", `Git failed (${args[0] ?? "git"}): ${detail}`, { args, detail });
  }
}

async function resolveDefaultRemoteRef(git: GitRunner, repoDir: string): Promise<string> {
  try {
    const head = (await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoDir)).trim();
    if (head) return head;
  } catch {
    // origin/HEAD may not be set on some servers or local repos; try updating it below.
  }
  try {
    await git(["remote", "set-head", "origin", "--auto"], repoDir);
    const head = (await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoDir)).trim();
    if (head) return head;
  } catch {
    // Fallback to checking origin/main, origin/master, or remote refs list.
  }
  for (const candidate of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
    try {
      await git(["rev-parse", "--verify", "--quiet", candidate], repoDir);
      return candidate;
    } catch {
      // keep looking
    }
  }
  const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin"], repoDir))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("/HEAD"));
  if (refs.length) return refs[0]!;
  return "HEAD";
}

/**
 * Clone or fetch a remote repository into `<hub>/remotes/<slug>`, check out `target.ref` (or the
 * remote's default branch), and return its local directory and checked-out commit SHA.
 */
export async function syncRemoteClone(hub: Hub, target: ParsedRemoteTarget, options: RemoteSyncOptions = {}): Promise<RemoteSyncResult> {
  const git = options.git ?? runGit;
  const repoDir = path.join(hub.remotesDir, target.slug);

  if (!(await isDirectory(path.join(repoDir, ".git")))) {
    if (await pathExists(repoDir)) {
      throw new SkillsymError(
        "REMOTE_FETCH_FAILED",
        `Remote cache path already exists without a git repository: ${repoDir}`,
        { path: repoDir, url: target.url },
      );
    }
    await fs.mkdir(hub.remotesDir, { recursive: true });
    await fs.mkdir(hub.tmpDir, { recursive: true });
    const staging = path.join(hub.tmpDir, `clone.${randomBytes(6).toString("hex")}`);
    try {
      await git(["clone", "--quiet", "--no-checkout", target.url, staging]);
      await renameWithRetry(staging, repoDir);
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
      throw err;
    }
  } else if (options.fetch !== false) {
    await git(["remote", "set-url", "origin", target.url], repoDir);
    await git(["fetch", "--quiet", "--tags", "--force", "--prune", "origin"], repoDir);
  }

  if (target.ref) {
    const remoteBranch = `refs/remotes/origin/${target.ref}`;
    let hasRemoteBranch = false;
    try {
      await git(["rev-parse", "--verify", "--quiet", remoteBranch], repoDir);
      hasRemoteBranch = true;
    } catch {
      hasRemoteBranch = false;
    }
    if (hasRemoteBranch) {
      await git(["checkout", "--quiet", "--force", "-B", target.ref, remoteBranch], repoDir);
    } else {
      await git(["checkout", "--quiet", "--force", target.ref], repoDir);
    }
  } else {
    const remoteRef = await resolveDefaultRemoteRef(git, repoDir);
    if (remoteRef.startsWith("refs/remotes/origin/")) {
      const branch = remoteRef.slice("refs/remotes/origin/".length);
      await git(["checkout", "--quiet", "--force", "-B", branch, remoteRef], repoDir);
    } else {
      await git(["checkout", "--quiet", "--force", remoteRef], repoDir);
    }
  }

  const commit = (await git(["rev-parse", "HEAD"], repoDir)).trim();
  return { repoDir, commit };
}

export type RemoteAddItemType = "add" | "adopt-remote" | "update" | "unchanged" | "conflict" | "skip";

export interface RemoteAddItem {
  name: string;
  /** Path to the skill folder inside the cached remote clone. */
  path: string;
  /** POSIX path relative to the cached repo root. */
  subpath: string;
  type: RemoteAddItemType;
  reason?: string;
  backup?: string;
  /** Existing agents preserved when attaching/updating a skill already in the hub. */
  attachedAgents?: string[];
}

export interface RemoteAddPlan {
  target: ParsedRemoteTarget;
  repoDir: string;
  commit: string;
  link: boolean;
  items: RemoteAddItem[];
}

export interface RemoteAddOptions {
  /** Only add/attach these skill names or glob patterns. */
  skills?: string[];
  /** Link `<hub>/skills/<name>` into `<hub>/remotes/<slug>` instead of copying. */
  link?: boolean;
  profiles?: AgentProfile[];
  git?: GitRunner;
  fetch?: boolean;
  lock?: LockOptions;
}

export interface RemoteAddResult extends RemoteAddPlan {
  added: SkillInfo[];
  snapshotFailed: string[];
}

/** Decide what adding or attaching skills from a remote repository would do. Only touches `<hub>/remotes/` cache. */
export async function planRemoteAdd(hub: Hub, target: ParsedRemoteTarget, options: RemoteAddOptions = {}): Promise<RemoteAddPlan> {
  const link = Boolean(options.link);
  const { repoDir, commit } = await syncRemoteClone(hub, target, { git: options.git, fetch: options.fetch });
  const searchRoot = target.subpath ? path.join(repoDir, target.subpath) : repoDir;
  if (!(await isDirectory(searchRoot))) {
    throw new SkillsymError("SKILL_NOT_FOUND_AT_PATH", `Subpath "${target.subpath}" not found in ${target.label}.`, {
      target: target.label,
      subpath: target.subpath,
    });
  }
  const discovered = await findLibrarySkills(searchRoot);
  if (!discovered.length) {
    throw new SkillsymError(
      "MISSING_SKILL_MD",
      `No skills found under ${target.label}${target.subpath ? `/${target.subpath}` : ""} (looked for SKILL.md folders).`,
      { target: target.label, subpath: target.subpath },
    );
  }
  const skills = filterLibrarySkills(discovered, options.skills, target.label);
  const manifest = await readManifest(hub.manifestPath);
  const items: RemoteAddItem[] = [];

  for (const s of skills) {
    const subpath = toPosixPath(path.relative(repoDir, s.path));
    const twins = skills.filter((o) => o.name.toLowerCase() === s.name.toLowerCase());
    if (!isValidSkillName(s.name)) {
      items.push({ name: s.name, path: s.path, subpath, type: "skip", reason: `"${s.name}" is not a valid skill name` });
      continue;
    }
    if (twins.length > 1) {
      items.push({
        name: s.name,
        path: s.path,
        subpath,
        type: "skip",
        reason: `the repository has ${twins.length} skills named "${s.name}" (${twins.map((t) => toPosixPath(path.relative(repoDir, t.path))).join(", ")})`,
      });
      continue;
    }

    const hubSkillDir = path.join(hub.skillsDir, s.name);
    const entry = manifest.skills[s.name];
    if (!entry) {
      if (await pathExists(hubSkillDir)) {
        items.push({
          name: s.name,
          path: s.path,
          subpath,
          type: "skip",
          reason: `a folder named "${s.name}" already exists in the hub without a manifest entry`,
        });
      } else {
        items.push({ name: s.name, path: s.path, subpath, type: "add" });
      }
      continue;
    }

    if (link) {
      if (entry.mode === "source-link" && entry.source && samePath(entry.source, s.path)) {
        const alreadySame =
          entry.remote?.url === target.url &&
          entry.remote?.subpath === subpath &&
          entry.remote?.commit === commit &&
          entry.remote?.ref === target.ref;
        items.push({
          name: s.name,
          path: s.path,
          subpath,
          type: alreadySame ? "unchanged" : "adopt-remote",
          ...(entry.agents.length ? { attachedAgents: [...entry.agents] } : {}),
        });
      } else {
        items.push({
          name: s.name,
          path: s.path,
          subpath,
          type: "skip",
          reason: `a skill named "${s.name}" is already in the hub; remove it first or omit --link to attach remote tracking`,
        });
      }
      continue;
    }

    if (entry.mode === "source-link") {
      if (entry.source && samePath(entry.source, s.path)) {
        const alreadySame =
          entry.remote?.url === target.url &&
          entry.remote?.subpath === subpath &&
          entry.remote?.commit === commit &&
          entry.remote?.ref === target.ref;
        items.push({
          name: s.name,
          path: s.path,
          subpath,
          type: alreadySame ? "unchanged" : "adopt-remote",
          ...(entry.agents.length ? { attachedAgents: [...entry.agents] } : {}),
        });
      } else {
        items.push({
          name: s.name,
          path: s.path,
          subpath,
          type: "skip",
          reason: `is linked from a local library (${entry.source ?? "unknown"}); unlink or remove it before replacing with a copy`,
        });
      }
      continue;
    }

    const upstreamHash = await hashSkillDir(s.path);
    const hubExists = await isDirectory(hubSkillDir);
    const hubHash = hubExists ? await hashSkillDir(hubSkillDir) : undefined;
    if (hubHash === upstreamHash) {
      const alreadySame =
        entry.remote?.url === target.url &&
        entry.remote?.subpath === subpath &&
        entry.remote?.commit === commit &&
        entry.remote?.ref === target.ref;
      items.push({
        name: s.name,
        path: s.path,
        subpath,
        type: alreadySame ? "unchanged" : "adopt-remote",
        ...(entry.agents.length ? { attachedAgents: [...entry.agents] } : {}),
      });
    } else if (!hubExists || (entry.sourceHash !== undefined && hubHash === entry.sourceHash)) {
      items.push({
        name: s.name,
        path: s.path,
        subpath,
        type: "update",
        ...(entry.agents.length ? { attachedAgents: [...entry.agents] } : {}),
      });
    } else {
      items.push({
        name: s.name,
        path: s.path,
        subpath,
        type: "conflict",
        reason: "differs from both upstream and its original version (modified locally); run `skillsym update` to decide",
        ...(entry.agents.length ? { attachedAgents: [...entry.agents] } : {}),
      });
    }
  }

  return { target, repoDir, commit, link, items };
}

/** Add new skills or attach/update remote tracking for existing skills in the hub. */
export async function addRemoteSkills(hub: Hub, target: ParsedRemoteTarget, options: RemoteAddOptions = {}): Promise<RemoteAddResult> {
  return withLock(
    hub.lockPath,
    async () => {
      const plan = await planRemoteAdd(hub, target, options);
      const added: SkillInfo[] = [];
      const snapshotFailed: string[] = [];
      const stamp = backupStamp();
      let changedHub = false;

      const remoteMeta = (item: RemoteAddItem): RemoteSkillInfo => ({
        url: target.url,
        ...(target.ref ? { ref: target.ref } : {}),
        subpath: item.subpath,
        commit: plan.commit,
      });

      for (const item of plan.items) {
        if (item.type === "add") {
          let info: SkillInfo;
          if (plan.link) {
            const dest = path.join(hub.skillsDir, item.name);
            await createDirLink(item.path, dest);
            info = { name: item.name, path: dest, agents: [], mode: "source-link", scope: "user", source: item.path };
          } else {
            info = await copyIntoHub(hub, item.name, item.path);
          }
          const manifest = await readManifest(hub.manifestPath);
          manifest.skills[item.name] = {
            agents: info.agents,
            mode: plan.link ? "source-link" : "link",
            scope: "user",
            source: item.path,
            sourceHash: await hashSkillDir(item.path),
            remote: remoteMeta(item),
          };
          await writeManifest(hub.manifestPath, manifest);
          added.push(info);
          changedHub = true;
        } else if (item.type === "adopt-remote") {
          const manifest = await readManifest(hub.manifestPath);
          const entry = manifest.skills[item.name]!;
          entry.source = item.path;
          entry.sourceHash = await hashSkillDir(item.path);
          entry.remote = remoteMeta(item);
          await writeManifest(hub.manifestPath, manifest);
          changedHub = true;
        } else if (item.type === "update") {
          const backup = await replaceHubSkillFromSource(hub, item.name, item.path, "remote-attach", stamp);
          if (backup) item.backup = backup;
          const manifest = await readManifest(hub.manifestPath);
          const entry = manifest.skills[item.name]!;
          entry.source = item.path;
          entry.sourceHash = await hashSkillDir(path.join(hub.skillsDir, item.name));
          entry.remote = remoteMeta(item);
          await writeManifest(hub.manifestPath, manifest);
          changedHub = true;
        } else if (item.type === "conflict") {
          // Attach remote provenance while leaving sourceHash and local hub edits untouched for `skillsym update`.
          const manifest = await readManifest(hub.manifestPath);
          const entry = manifest.skills[item.name];
          if (entry && !entry.remote) {
            entry.remote = remoteMeta(item);
            await writeManifest(hub.manifestPath, manifest);
          }
        }
      }

      if (plan.link && plan.items.some((i) => i.type === "add" || i.type === "adopt-remote")) {
        const manifest = await readManifest(hub.manifestPath);
        const searchRoot = target.subpath ? path.join(plan.repoDir, target.subpath) : plan.repoDir;
        const libraries = manifest.libraries ?? [];
        if (!libraries.some((l) => samePath(l, searchRoot))) {
          manifest.libraries = [...libraries, searchRoot];
          await writeManifest(hub.manifestPath, manifest);
        }
        snapshotFailed.push(...(await refreshLibrarySnapshots(hub)));
      }

      if (changedHub) {
        const manifest = await readManifest(hub.manifestPath);
        await refreshSkillsJsonManifests(hub, options.profiles ?? builtinAgents(), manifest);
      }

      return { ...plan, added, snapshotFailed };
    },
    options.lock,
  );
}

/** Inspect whether a local skill directory lives inside a git repository and return its root, commit, and origin URL. */
export async function inspectLocalGitSource(dir: string, git: GitRunner = runGit): Promise<LocalGitSource | null> {
  const absDir = path.resolve(dir);
  if (!(await isDirectory(absDir)) || !(await isInGit(absDir))) return null;
  let root: string;
  let commit: string;
  try {
    root = path.resolve((await git(["rev-parse", "--show-toplevel"], absDir)).trim());
    commit = (await git(["rev-parse", "HEAD"], root)).trim();
  } catch {
    return null;
  }
  let url: string | undefined;
  try {
    url = (await git(["remote", "get-url", "origin"], root)).trim() || undefined;
  } catch {
    url = undefined;
  }
  return { root, ...(url ? { url } : {}), commit, subpath: toPosixPath(path.relative(root, absDir)) };
}

export interface DiscoverOriginOptions {
  /** Original source directory where the skill came from (if known). */
  sourceDir?: string;
  /** Hub used to infer `<hub>/../.agents/.skill-lock.json` cleanly in isolated tests and real runs. */
  hub?: Hub;
  /** Explicit user home directory for finding `~/.agents/.skill-lock.json`. */
  homedir?: string;
  /** Agent profiles used to locate `.skill-lock.json` / `skills-lock.json` next to agent folders. */
  profiles?: AgentProfile[];
  git?: GitRunner;
}

function unquoteYaml(val: string): string {
  const t = val.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function normalizeSkillSubpath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let cleaned = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
  if (!cleaned || cleaned === "." || cleaned === "SKILL.md") return "";
  if (cleaned.endsWith("/SKILL.md")) cleaned = cleaned.slice(0, -"/SKILL.md".length);
  return cleaned === "." ? "" : cleaned;
}

function parseFrontmatterOrigin(rawMd: string): { repo?: string; subpath?: string; ref?: string } | null {
  const fmMatch = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(rawMd);
  if (!fmMatch) return null;

  const fields = new Map<string, string>();
  let section: string | undefined;
  for (const line of fmMatch[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const kv = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) {
      if (indent === 0) section = undefined;
      continue;
    }
    const key = kv[1]!.toLowerCase();
    const val = unquoteYaml(kv[2]!);
    if (indent === 0) {
      section = val ? undefined : key;
      if (val) fields.set(key, val);
    } else if (section && val) {
      fields.set(`${section}.${key}`, val);
    }
  }

  const repo =
    fields.get("repository") ??
    fields.get("sourceurl") ??
    fields.get("metadata.repository") ??
    fields.get("metadata.sourceurl") ??
    fields.get("source") ??
    fields.get("metadata.source");
  if (!repo) return null;

  const subpath = normalizeSkillSubpath(
    fields.get("subpath") ?? fields.get("skillpath") ?? fields.get("metadata.subpath") ?? fields.get("metadata.skillpath"),
  );
  const ref = fields.get("ref") ?? fields.get("branch") ?? fields.get("metadata.ref") ?? fields.get("metadata.branch");
  return { repo, ...(subpath !== undefined ? { subpath } : {}), ...(ref ? { ref } : {}) };
}

function lockfileCandidateDirs(options: DiscoverOriginOptions): string[] {
  const dirs: string[] = [];
  const add = (p: string | undefined) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (!dirs.some((d) => samePath(d, resolved))) dirs.push(resolved);
  };

  if (options.sourceDir) {
    let cur = path.dirname(path.resolve(options.sourceDir));
    for (let i = 0; i < 4; i++) {
      add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  if (options.homedir) {
    add(path.join(options.homedir, ".agents"));
    add(options.homedir);
  }
  for (const p of options.profiles ?? []) {
    add(path.dirname(p.skillsDir));
    add(p.skillsDir);
    for (const r of p.alsoReads) add(path.dirname(r));
  }
  if (options.hub) {
    add(path.join(path.dirname(options.hub.home), ".agents"));
  }
  return dirs;
}

async function discoverFromLockfiles(skillName: string, options: DiscoverOriginOptions): Promise<RemoteSkillInfo | null> {
  for (const dir of lockfileCandidateDirs(options)) {
    for (const file of [".skill-lock.json", "skills-lock.json"]) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(dir, file), "utf8");
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const skillsObj = (parsed as { skills?: Record<string, unknown> }).skills;
      const entry = skillsObj && typeof skillsObj === "object" ? skillsObj[skillName] : undefined;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

      const rec = entry as Record<string, unknown>;
      const rawUrl =
        (typeof rec.sourceUrl === "string" && rec.sourceUrl.trim()) ||
        ((rec.sourceType === "github" || (typeof rec.source === "string" && rec.source.includes("/"))) &&
          typeof rec.source === "string" &&
          rec.source.trim()) ||
        "";
      if (!rawUrl) continue;

      let target: ParsedRemoteTarget | null = null;
      try {
        target = parseRemoteSpec(rawUrl);
      } catch {
        target = null;
      }
      if (!target) continue;

      const subpath =
        typeof rec.skillPath === "string" ? (normalizeSkillSubpath(rec.skillPath) ?? target.subpath) : target.subpath;
      const ref =
        (typeof rec.ref === "string" && rec.ref.trim()) ||
        (typeof rec.branch === "string" && rec.branch.trim()) ||
        target.ref;
      return { url: target.url, ...(ref ? { ref } : {}), subpath, commit: "" };
    }
  }
  return null;
}

/**
 * Offline auto-discovery of a skill's online origin from `SKILL.md` frontmatter, `npx skills`
 * lockfiles (`.skill-lock.json` / `skills-lock.json`), or a local git repo's `origin` remote.
 */
export async function discoverSkillOrigin(
  skillName: string,
  skillDir: string,
  options: DiscoverOriginOptions = {},
): Promise<RemoteSkillInfo | null> {
  // 1. Check SKILL.md YAML frontmatter (`repository`, `sourceUrl`, `source`).
  try {
    const rawMd = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const fm = parseFrontmatterOrigin(rawMd);
    if (fm?.repo) {
      let target: ParsedRemoteTarget | null = null;
      try {
        target = parseRemoteSpec(fm.repo);
      } catch {
        target = null;
      }
      if (target) {
        const ref = fm.ref ?? target.ref;
        const subpath = fm.subpath ?? target.subpath;
        return { url: target.url, ...(ref ? { ref } : {}), subpath, commit: "" };
      }
    }
  } catch {
    // Missing or unreadable SKILL.md falls through to lockfiles / git origin.
  }

  // 2. Check `.skill-lock.json` / `skills-lock.json` near sourceDir, profiles, homedir, or hub parent.
  const fromLock = await discoverFromLockfiles(skillName, options);
  if (fromLock) return fromLock;

  // 3. Check if `sourceDir` sits inside a local git checkout with a configured `origin` remote URL.
  if (options.sourceDir) {
    const localGit = await inspectLocalGitSource(options.sourceDir, options.git);
    if (localGit?.url) {
      return { url: localGit.url, subpath: localGit.subpath, commit: localGit.commit };
    }
  }

  return null;
}

const GITHUB_URL_IN_TEXT_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/tree\/[A-Za-z0-9_.~/%-]+)?/gi;

function upstreamKey(u: RemoteSkillInfo): string {
  return `${u.url}\0${u.ref ?? ""}\0${u.subpath}`;
}

/**
 * Offline discovery of multiple upstream sources referenced by a combined/orchestrator skill:
 * scans `NOTICE.md` for explicit GitHub URLs and nested sub-skill folders (e.g. `_archive/* /SKILL.md`)
 * via `discoverSkillOrigin`. Never overwrites or modifies hub files.
 */
export async function discoverSkillUpstreams(
  _skillName: string,
  skillDir: string,
  options: DiscoverOriginOptions = {},
): Promise<RemoteSkillInfo[]> {
  const found: RemoteSkillInfo[] = [];
  const seen = new Set<string>();
  const add = (info: RemoteSkillInfo | null) => {
    if (!info) return;
    const key = upstreamKey(info);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(info);
  };

  // 1. Explicit https://github.com/<owner>/<repo> links in NOTICE.md.
  try {
    const notice = await fs.readFile(path.join(skillDir, "NOTICE.md"), "utf8");
    for (const m of notice.matchAll(GITHUB_URL_IN_TEXT_RE)) {
      const cleaned = m[0]!.replace(/[.,;:)>]+$/, "");
      try {
        const parsed = parseRemoteSpec(cleaned);
        if (parsed) {
          add({
            url: parsed.url,
            ...(parsed.ref ? { ref: parsed.ref } : {}),
            subpath: parsed.subpath,
            commit: "",
          });
        }
      } catch {
        // Ignore malformed links in prose.
      }
    }
  } catch {
    // NOTICE.md is optional.
  }

  // 2. Nested child sub-skills (e.g. `_archive/00-start-here/SKILL.md`), excluding root SKILL.md.
  async function walkNested(dir: string, depth: number): Promise<void> {
    if (depth > 0 && (await isFile(path.join(dir, "SKILL.md")))) {
      add(
        await discoverSkillOrigin(path.basename(dir), dir, {
          hub: options.hub,
          homedir: options.homedir,
          profiles: options.profiles,
          git: options.git,
        }),
      );
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === ".git" || e.name === "node_modules") continue;
      await walkNested(path.join(dir, e.name), depth + 1);
    }
  }
  await walkNested(skillDir, 0);

  return found;
}

export interface AttachUpstreamItem {
  url: string;
  ref?: string;
  subpath: string;
  commit: string;
  type: "added" | "updated" | "unchanged";
}

export interface AttachUpstreamResult {
  hostSkill: string;
  target: ParsedRemoteTarget;
  repoDir: string;
  commit: string;
  items: AttachUpstreamItem[];
}

/**
 * Attach one or more watched upstream sources from `target` to an existing hub skill (`hostSkill`)
 * in `manifest.json` without modifying any files inside `<hub>/skills/<hostSkill>/`.
 */
export async function addRemoteUpstreams(
  hub: Hub,
  target: ParsedRemoteTarget,
  hostSkill: string,
  options: RemoteAddOptions & { dryRun?: boolean } = {},
): Promise<AttachUpstreamResult> {
  const run = async (): Promise<AttachUpstreamResult> => {
    const manifest = await readManifest(hub.manifestPath);
    const entry = manifest.skills[hostSkill];
    if (!entry) {
      throw new SkillsymError("SKILL_NOT_IN_HUB", `No skill named "${hostSkill}" in the hub.`, { skill: hostSkill });
    }

    const { repoDir, commit } = await syncRemoteClone(hub, target, { git: options.git, fetch: options.fetch });
    const searchRoot = target.subpath ? path.join(repoDir, target.subpath) : repoDir;
    if (!(await isDirectory(searchRoot))) {
      throw new SkillsymError("SKILL_NOT_FOUND_AT_PATH", `Subpath "${target.subpath}" not found in ${target.label}.`, {
        target: target.label,
        subpath: target.subpath,
      });
    }

    const toWatch: RemoteSkillInfo[] = [];
    if (options.skills?.length) {
      const discovered = await findLibrarySkills(searchRoot);
      if (!discovered.length) {
        throw new SkillsymError("MISSING_SKILL_MD", `No skills found under ${target.label}${target.subpath ? `/${target.subpath}` : ""}.`, {
          target: target.label,
          subpath: target.subpath,
        });
      }
      const selected = filterLibrarySkills(discovered, options.skills, target.label);
      for (const s of selected) {
        toWatch.push({
          url: target.url,
          ...(target.ref ? { ref: target.ref } : {}),
          subpath: toPosixPath(path.relative(repoDir, s.path)),
          commit,
        });
      }
    } else {
      toWatch.push({
        url: target.url,
        ...(target.ref ? { ref: target.ref } : {}),
        subpath: target.subpath,
        commit,
      });
    }

    const current = [...(entry.upstreams ?? [])];
    const items: AttachUpstreamItem[] = [];
    for (const next of toWatch) {
      const idx = current.findIndex((u) => upstreamKey(u) === upstreamKey(next));
      if (idx === -1) {
        current.push(next);
        items.push({ ...next, type: "added" });
      } else if (current[idx]!.commit !== next.commit) {
        current[idx] = next;
        items.push({ ...next, type: "updated" });
      } else {
        items.push({ ...next, type: "unchanged" });
      }
    }

    if (!options.dryRun && items.some((i) => i.type !== "unchanged")) {
      entry.upstreams = current;
      await writeManifest(hub.manifestPath, manifest);
    }

    return { hostSkill, target, repoDir, commit, items };
  };

  return options.dryRun ? run() : withLock(hub.lockPath, run, options.lock);
}
