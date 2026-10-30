export type ErrorCode =
  | "SKILL_EXISTS"
  | "SKILL_NOT_FOUND_AT_PATH"
  | "MISSING_SKILL_MD"
  | "INVALID_SKILL_NAME"
  | "MANIFEST_CORRUPT"
  | "UNSUPPORTED_MANIFEST_VERSION"
  | "LOCK_TIMEOUT"
  | "UNKNOWN_AGENT"
  | "SKILL_NOT_IN_HUB"
  | "STATE_CORRUPT"
  | "UNSUPPORTED_STATE_VERSION";

/** Every failure core reports to callers. Callers map it to output and exit codes. */
export class SkillsymError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SkillsymError";
    this.code = code;
    this.details = details;
  }
}
