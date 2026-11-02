/** What `skillsym <command> -h` prints. A test checks each one against the options the command accepts. */
export const COMMAND_HELP: Record<string, string> = {
  init: `Usage: skillsym init [name]

Create a SKILL.md template to fill in, in ./<name>, or here without a name. Nothing goes into the hub yet.

Examples:
  skillsym init my-skill
  skillsym add my-skill -a claude     Next step: put it in the hub and link it`,

  add: `Usage: skillsym add <path> [options]

Copy a skill into the hub. A folder without its own SKILL.md is a library: every skill in it is added, at any
depth, and the library itself is not changed.

Options:
  -a, --agent <ids>  Also link it into these agents; '*' = every installed agent
  --all              Same as -a '*'
  --link             Link the hub to your library instead of copying, so the library stays the source of truth.
                     Run it again to pick up new skills, or to point at the library's new location
  --dry-run          Preview adding a library (adding one skill changes only the hub)
  -y, --yes          Accepted; add never asks

Examples:
  skillsym add ./my-skill -a claude,codex
  skillsym add ~/my-skills --dry-run
  skillsym add ~/my-skills --link -a claude`,

  assign: `Usage: skillsym assign <skill...> -a <agents> [options]

Link skills that are in the hub into agents' skills folders. An agent that already sees the skill through another
agent's folder gets no second link.

Options:
  -a, --agent <ids>  Agents, comma-separated or repeated; '*' = every installed agent
  -s, --skill <name> Skill names, instead of listing them first; '*' = every skill in the hub
  --all              Every skill to every installed agent (-s '*' -a '*')
  -y, --yes          Accepted; assign never asks

Names may be patterns: * means any characters, ? one. Keep the quotes.

Examples:
  skillsym assign research -a claude,codex
  skillsym assign 'gcp-*' -a claude
  skillsym assign --all`,

  list: `Usage: skillsym list [options]     (or: skillsym ls)

List the skills in the hub, their agents, and where linked skills come from.

Options:
  -a, --agent <ids>  Only skills assigned to these agents

Examples:
  skillsym list
  skillsym list -a codex`,

  open: `Usage: skillsym open <skill>

Print a skill's folder and open it in $VISUAL or $EDITOR, or your file manager if neither is set. A --link skill
opens in your library, where it really lives. Without a terminal it only prints the path.

Examples:
  skillsym open research`,

  status: `Usage: skillsym status [skill...] [options]

Show links by status: what needs attention, unmanaged skills, news from linked libraries, and a count.

Options:
  --all              Also list links that are fine, and the name of every unmanaged skill
  --only <states>    Only these statuses, comma-separated
  -a, --agent <ids>  Only these agents
  -s, --skill <name> Skill names, instead of listing them first

Names may be patterns: * means any characters, ? one. Keep the quotes.

Statuses:
  synced          Our link is in place
  covered         The agent already sees the skill through another agent's folder
  missing         Assigned, but nothing is there          sync links it, or asks if our link was removed
  dangling        Our link points at nothing              sync re-links it
  replaced        Something replaced our link             sync re-links an identical copy, asks about a different one
  blocked         Holds something skillsym didn't create  use import
  orphaned        Our link is no longer assigned          sync removes it
  duplicate       The agent also loads it from elsewhere  sync removes this link
  source-missing  A --link skill's library is gone        sync asks
  unmanaged       A skill skillsym does not manage        use import

Examples:
  skillsym status
  skillsym status --all
  skillsym status --only missing,replaced
  skillsym status --only unmanaged
  skillsym status 'gcp-*' -a codex --all`,

  check: `Usage: skillsym check [skill...] [options]

Same as status, for CI and scripts: exits 0 if everything asked about is in sync, 1 if not.

Options:
  --all              Also list links that are fine, and the name of every unmanaged skill
  --only <states>    Only these statuses, comma-separated (skillsym status -h lists them)
  -a, --agent <ids>  Only these agents
  -s, --skill <name> Skill names, instead of listing them first

Examples:
  skillsym check
  skillsym check research -a claude`,

  sync: `Usage: skillsym sync [skill...] [options]

Make the agents' folders match the manifest. Fixes what it can decide alone and asks about the rest; run it twice
and the second run changes nothing. Questions: Enter skips one, q skips the rest, Ctrl+C cancels.

Options:
  -a, --agent <ids>  Only these agents
  -s, --skill <name> Skill names, instead of listing them first
  --dry-run          Show what would change; change nothing
  -y, --yes          Never ask: conflicts are reported and left alone

Names may be patterns: * means any characters, ? one. Keep the quotes.

Examples:
  skillsym sync --dry-run
  skillsym sync
  skillsym sync web-tools
  skillsym sync 'gcp-*' -a codex`,

  import: `Usage: skillsym import [skill...] [options]

Move skills found in agents' folders into the hub: originals are backed up and replaced by links. Identical copies
merge by themselves. For copies that differ you choose: keep one, keep both, or merge with git-style markers.

Options:
  -a, --agent <ids>  Only copies in these agents' folders; other agents' copies are not compared or touched
  -s, --skill <name> Skill names, instead of listing them first
  --dry-run          Show what would change; change nothing
  -y, --yes          Never ask: copies that differ are reported and left alone
  --continue         Finish an open merge, after editing it
  --abort            Drop an open merge; the agents' copies were never changed

Names may be patterns: * means any characters, ? one. Keep the quotes.

Examples:
  skillsym import --dry-run
  skillsym import
  skillsym import research -a claude
  skillsym import 'gcp-*'
  skillsym import --continue`,

  remove: `Usage: skillsym remove <skill...> [options]     (or: skillsym rm)

With -a: those agents lose the skill, and it stays in the hub. Without -a: every agent loses it and it leaves the
hub, asking first; the hub copy moves to backups, and a linked library is never touched.

To leave an agent a real copy instead, use skillsym eject.

Options:
  -a, --agent <ids>  Only unassign these agents
  -s, --skill <name> Skill names, instead of listing them first; '*' = every skill in the hub
  --all              Every skill in the hub (same as -s '*')
  --dry-run          Show what would change; change nothing
  -y, --yes          Do not ask first

Names may be patterns: * means any characters, ? one. Keep the quotes.

Examples:
  skillsym remove research -a codex
  skillsym remove research --dry-run
  skillsym remove 'test-*' -a claude`,

  eject: `Usage: skillsym eject [skill...] [options]

Replace links with real copies of the latest hub version, so agents keep working without skillsym. Asks first.

With no names and no -a, every link: you stop using skillsym, and the hub stays until you delete it. With names or
-a, only those links, and everything else stays managed; a skill no agent uses afterwards leaves the hub, with its
copy in backups.

Options:
  -a, --agent <ids>  Only these agents' links
  -s, --skill <name> Skill names, instead of listing them first
  --dry-run          Show what would change; change nothing
  -y, --yes          Do not ask first

Names may be patterns: * means any characters, ? one. Keep the quotes.

Examples:
  skillsym eject --dry-run
  skillsym eject research -a claude
  skillsym eject -a gemini`,

  config: `Usage: skillsym config [add <id> <folder> | remove <id>]

Without arguments, show the config file's location and every agent with its skills folder.

  config add <id> <folder>  Add an agent. A folder may start with ~; a relative one is taken from where you are
  config remove <id>        Take an agent out; refused while skills are assigned to it. Its files are not touched

To change a folder, or to set other fields such as alsoReads, edit the config file.

Examples:
  skillsym config
  skillsym config add windsurf ~/.windsurf/skills
  skillsym config remove windsurf`,
};

const ALIASES: Record<string, string> = { ls: "list", rm: "remove" };

/** Help for one command, or undefined if there is no such command. */
export function commandHelp(command: string): string | undefined {
  const text = COMMAND_HELP[ALIASES[command] ?? command];
  return text && `${text}\n\nAlso: --json for machine-readable output, -h for this help.`;
}
