export { SkillsymError, type ErrorCode } from "./errors.js";
export { isDirectory, isFile } from "./fsutil.js";
export { openHub, resolveHubHome, hubPaths, type Hub, type ResolveHomeOptions } from "./hub.js";
export {
  MANIFEST_VERSION,
  readManifest,
  writeManifest,
  emptyManifest,
  type Manifest,
  type ManifestSkill,
  type RemoteSkillInfo,
  type SkillMode,
  type SkillScope,
} from "./manifest.js";
export { STATE_VERSION, readState, writeState, type State, type StateLink, type StateManifest, type LinkKind } from "./state.js";
export { withLock, type LockOptions } from "./lock.js";
export { hasLibrarySnapshot, refreshLibrarySnapshots } from "./snapshots.js";
export { findLibrary, listLibraries, removeLibrary, unlinkLibrary, type LibraryInfo, type UnlinkResult, type UnlinkedSkill } from "./libraries.js";
export { isInGit } from "./library.js";
export { addSkill, listSkills, replaceHubSkillFromSource, isValidSkillName, expandSkillNames, type SkillInfo, type AddSkillOptions } from "./skills.js";
export {
  agentDelivery,
  builtinAgents,
  resolveAgents,
  isAgentInstalled,
  groupBySkillsDir,
  planLinkGroups,
  type AgentProfile,
  type DeliveryMode,
  type LinkGroup,
} from "./agents.js";
export {
  generatedManifestPath,
  computeSkillsJsonEntries,
  applySkillsJsonDelivery,
  readTargetSkillsJson,
  readGeneratedFile,
  hasInheritsRef,
  upsertInheritsRef,
  removeInheritsRef,
  findStateManifest,
  type SkillsJsonEntry,
  type DesiredSkillsJson,
} from "./skills-json.js";
export { addConfigAgent, removeConfigAgent, ensureConfig, loadProfiles, readConfig, CONFIG_VERSION, type Config, type AgentConfig } from "./config.js";
export { hashSkillDir, hasUtf8Bom } from "./hash.js";
export {
  scanStatus,
  filterStatus,
  type StatusFilter,
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
  planImport,
  importSkills,
  type ImportPlan,
  type ImportItem,
  type ImportItemType,
  type ImportItemResult,
  type ImportResult,
  type ImportSource,
  type ImportOptions,
} from "./import.js";
export {
  resolveImportConflicts,
  continueImport,
  abortImport,
  readPendingImport,
  importVersions,
  type ImportChoice,
  type ImportDecision,
  type ImportDecisionResult,
  type ImportVersion,
  type PendingImport,
  type BinaryConflict,
} from "./import-conflicts.js";
export { initSkill, type InitResult } from "./init.js";
export {
  findLibrarySkills,
  filterLibrarySkills,
  planLibraryAdd,
  addLibrary,
  type LibrarySkill,
  type LibraryItem,
  type LibraryItemType,
  type LibraryPlan,
  type LibraryAddResult,
  type LibraryOptions,
} from "./library.js";
export { cloudSyncProvider, hubLocationWarnings } from "./safety.js";
export {
  planAntigravityMigration,
  applyAntigravityMigration,
  type MigrationPlan,
  type MigrationResult,
  type MigrationOptions,
} from "./migrate.js";
export { eject, type EjectOptions, type EjectReport, type EjectResult, type EjectOutcome } from "./eject.js";
export {
  removeSkills,
  type RemoveOptions,
  type RemoveResult,
  type RemoveLinkResult,
  type RemoveOutcome,
  type RemovedSkill,
} from "./remove.js";
export {
  resolveConflicts,
  choicesFor,
  choicesForConflict,
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
export {
  planUpdate,
  updateSkills,
  resolveUpdateConflicts,
  markUpstreamsReviewed,
  type UpdateItemStatus,
  type UpdateItem,
  type UpstreamChange,
  type UpdateOptions,
  type UpdatePlan,
  type UpdateResult,
  type UpdateChoice,
  type UpdateDecision,
  type UpdateResolution,
  type UpstreamReviewChoice,
  type UpstreamReviewDecision,
  type UpstreamReviewResult,
} from "./update.js";
export {
  parseRemoteTarget,
  syncRemoteClone,
  discoverSkillOrigin,
  discoverSkillUpstreams,
  planRemoteAdd,
  addRemoteSkills,
  addRemoteUpstreams,
  inspectLocalGitSource,
  runGit,
  slugForRemote,
  toPosixPath,
  type ParsedRemoteTarget,
  type DiscoverOriginOptions,
  type AttachUpstreamItem,
  type AttachUpstreamResult,
  type GitRunner,
  type RemoteSyncOptions,
  type RemoteSyncResult,
  type RemoteAddItemType,
  type RemoteAddItem,
  type RemoteAddPlan,
  type RemoteAddOptions,
  type RemoteAddResult,
  type LocalGitSource,
} from "./remote.js";
