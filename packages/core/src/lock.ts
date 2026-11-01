import { promises as fs } from "node:fs";
import { SkillsymError } from "./errors.js";

export interface LockOptions {
  /** How long to wait for another process to release the lock. */
  timeoutMs?: number;
  retryMs?: number;
}

interface LockInfo {
  pid: number;
  createdAt: string;
}

/**
 * Run `fn` while holding the hub's lock file, so the CLI and a future daemon never write at the
 * same time. The lock is a file created with O_EXCL; a lock left behind by a dead process is
 * reclaimed.
 */
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  await acquire(lockPath, options);
  try {
    return await fn();
  } finally {
    await removeLock(lockPath);
  }
}

/** Windows can briefly refuse to delete a file another process is opening; rm retries those errors. */
function removeLock(lockPath: string): Promise<void> {
  return fs.rm(lockPath, { force: true, maxRetries: 5, retryDelay: 20 });
}

async function acquire(lockPath: string, options: LockOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  const info: LockInfo = { pid: process.pid, createdAt: new Date().toISOString() };

  for (;;) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(info), { encoding: "utf8", flag: "wx" });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // On Windows, opening a lock file that is being deleted fails with EPERM: it is about to be free.
      const beingDeleted = process.platform === "win32" && code === "EPERM";
      if (code !== "EEXIST" && !(beingDeleted && Date.now() < deadline)) throw err;
    }
    if (await isStale(lockPath)) {
      await removeLock(lockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new SkillsymError("LOCK_TIMEOUT", `Another skillsym process is using the hub (lock: ${lockPath}).`, { lockPath });
    }
    await new Promise((r) => setTimeout(r, retryMs));
  }
}

async function isStale(lockPath: string): Promise<boolean> {
  let info: Partial<LockInfo>;
  try {
    info = JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch (err) {
    // Vanished between our create attempt and this read: let the caller retry.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Unreadable or half-written; only treat as stale once it is clearly old.
    return olderThan(lockPath, 30_000);
  }
  if (typeof info.pid !== "number") return olderThan(lockPath, 30_000);
  return !processAlive(info.pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function olderThan(file: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs > ms;
  } catch {
    return false;
  }
}
