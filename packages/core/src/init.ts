import { promises as fs } from "node:fs";
import path from "node:path";
import { SkillsymError } from "./errors.js";
import { pathExists, writeFileAtomic } from "./fsutil.js";
import { isValidSkillName } from "./skills.js";

export interface InitResult {
  name: string;
  /** The skill folder (contains SKILL.md). */
  dir: string;
  skillMd: string;
}

/**
 * Create a SKILL.md template, the same way `npx skills init` does: with a name, in a new folder
 * `<cwd>/<name>`; without one, in `cwd` itself, named after that folder. Never overwrites anything.
 * The file is UTF-8 without a BOM so Codex can load it.
 */
export async function initSkill(cwd: string, name?: string): Promise<InitResult> {
  const dir = name ? path.resolve(cwd, name) : path.resolve(cwd);
  const skillName = path.basename(dir);
  if (!isValidSkillName(skillName)) {
    throw new SkillsymError(
      "INVALID_SKILL_NAME",
      `"${skillName}" is not a valid skill name (letters, digits, ".", "_", "-"; up to 64 characters).` +
        (name ? "" : " Run `skillsym init <name>` to create the skill in a new folder instead."),
      { name: skillName },
    );
  }
  if (name && (await pathExists(dir))) {
    throw new SkillsymError("SKILL_EXISTS", `${dir} already exists; choose another name or remove it first.`, { name: skillName, path: dir });
  }
  const skillMd = path.join(dir, "SKILL.md");
  if (await pathExists(skillMd)) {
    throw new SkillsymError("SKILL_EXISTS", `${skillMd} already exists; nothing was changed.`, { name: skillName, path: skillMd });
  }
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(skillMd, template(skillName));
  return { name: skillName, dir, skillMd };
}

function template(name: string): string {
  const title = name.replace(/[-_.]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return `---
name: ${name}
description: Describe what this skill does and when an agent should use it, in one or two sentences.
---

# ${title}

## When to use

- Describe the situations or requests where this skill applies.

## Instructions

1. Write the steps the agent should follow.
2. Point to any files in this folder the agent should read (for example references/ or scripts/).
`;
}
