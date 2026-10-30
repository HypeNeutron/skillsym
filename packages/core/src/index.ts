export { SkillsymError, type ErrorCode } from "./errors.js";
export { openHub, resolveHubHome, hubPaths, type Hub, type ResolveHomeOptions } from "./hub.js";
export {
  MANIFEST_VERSION,
  readManifest,
  writeManifest,
  emptyManifest,
  type Manifest,
  type ManifestSkill,
  type SkillMode,
  type SkillScope,
} from "./manifest.js";
export { STATE_VERSION, readState, writeState, type State, type StateLink, type LinkKind } from "./state.js";
export { withLock, type LockOptions } from "./lock.js";
export { addSkill, listSkills, isValidSkillName, type SkillInfo, type AddSkillOptions } from "./skills.js";
export { builtinAgents, resolveAgents, isAgentInstalled, groupBySkillsDir, type AgentProfile } from "./agents.js";
export { hashSkillDir, hasUtf8Bom } from "./hash.js";
export {
  scanStatus,
  type StatusReport,
  type StatusEntry,
  type LinkStatus,
  type UnmanagedEntry,
  type StatusWarning,
  type ScanOptions,
} from "./status.js";
export { readLinkTarget, removeDirLink } from "./links.js";
export {
  planSync,
  sync,
  type SyncPlan,
  type SyncResult,
  type SyncAction,
  type SyncActionType,
  type SyncActionResult,
  type SyncConflict,
  type SyncConflictType,
  type SyncOptions,
} from "./sync.js";
export {
  resolveConflicts,
  choicesFor,
  defaultForkName,
  type ConflictChoice,
  type ConflictDecision,
  type ConflictResolution,
} from "./conflicts.js";
export {
  assignSkills,
  type AssignOptions,
  type AssignResult,
  type AgentLinkResult,
  type LinkOutcome,
} from "./assign.js";
