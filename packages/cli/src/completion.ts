/** What the shell scripts below ask for, and what they do with the answer. */

/** What can be offered; each list is read only if this completion needs it, so Tab stays quick. */
export interface CompletionSource {
  commands: string[];
  /** Options each command accepts, by long name. */
  options: Record<string, string[]>;
  statuses: string[];
  skills: () => Promise<string[]>;
  importable: () => Promise<string[]>;
  agents: () => Promise<string[]>;
  /** Agents in the config file: the only ones `config remove` can take. */
  configAgents: () => Promise<string[]>;
}

const ALIASES: Record<string, string> = { ls: "list", rm: "remove" };
/** Options that take a value, so the word after them is not a skill name. */
const VALUE_OPTIONS = ["-a", "--agent", "-s", "--skill", "--only"];
export const COMPLETION_SHELLS = ["powershell", "bash", "zsh"];

/** Candidates for the word being typed (`current`), given the words before it. */
export async function complete(current: string, before: string[], source: CompletionSource): Promise<string[]> {
  const typed = current.replace(/^['"]/, "");
  const matching = (items: string[]) => [...new Set(items)].filter((i) => i.toLowerCase().startsWith(typed.toLowerCase()));

  const positionals = before.filter((word, i) => !word.startsWith("-") && !VALUE_OPTIONS.includes(before[i - 1] ?? ""));
  const [first, ...rest] = positionals;
  const previous = before[before.length - 1];

  // A value list can be comma-separated: complete after the last comma, and offer each value once.
  const fromList = (items: string[]) => {
    const cut = typed.lastIndexOf(",") + 1;
    const head = typed.slice(0, cut);
    const chosen = head.split(",");
    const tail = typed.slice(cut).toLowerCase();
    return items.filter((i) => !chosen.includes(i) && i.toLowerCase().startsWith(tail)).map((i) => head + i);
  };
  if (previous === "-a" || previous === "--agent") return fromList(await source.agents());
  if (previous === "--only") return fromList(source.statuses);
  if (previous === "-s" || previous === "--skill") return matching(await source.skills());

  if (!first) return typed.startsWith("-") ? matching(["--help", "--version"]) : matching(source.commands);
  const command = ALIASES[first] ?? first;

  if (typed.startsWith("-")) {
    const accepted = source.options[command];
    return accepted ? matching([...accepted.map((o) => `--${o}`), "--json", "--help"]) : [];
  }

  // Skills already on the line are not offered again.
  const unused = (names: string[]) => matching(names).filter((n) => !rest.includes(n));
  switch (command) {
    case "help":
      return rest.length ? [] : matching(source.commands);
    case "completion":
      return rest.length ? [] : matching(COMPLETION_SHELLS);
    case "config":
      if (!rest.length) return matching(["add", "remove"]);
      if ((rest[0] === "remove" || rest[0] === "rm") && rest.length === 1) return matching(await source.configAgents());
      return [];
    case "open":
      return rest.length ? [] : unused(await source.skills());
    case "assign":
    case "remove":
    case "eject":
    case "sync":
      return unused(await source.skills());
    case "status":
    case "check":
      return unused([...(await source.skills()), ...(await source.importable())]);
    case "import":
      return unused(await source.importable());
    // add takes a path, and init a new name: the shell's own completion is the right one.
    default:
      return [];
  }
}

const POWERSHELL = `# skillsym Tab completion for PowerShell.
# Turn it on for good by adding this to your profile:
#   if (!(Test-Path $PROFILE)) { New-Item $PROFILE -ItemType File -Force | Out-Null }
#   skillsym completion powershell | Add-Content $PROFILE
Register-ArgumentCompleter -Native -CommandName skillsym, ssym -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $before = @($commandAst.CommandElements | Select-Object -Skip 1 |
        Where-Object { $_.Extent.EndOffset -lt $cursorPosition -or ($_.Extent.EndOffset -eq $cursorPosition -and $wordToComplete -eq '') } |
        ForEach-Object { $_.ToString() })
    # The "=" keeps an empty word: Windows PowerShell drops empty arguments.
    & skillsym __complete "=$wordToComplete" @before 2>$null | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
}`;

const BASH = `# skillsym Tab completion for bash.
# Turn it on for good:
#   skillsym completion bash >> ~/.bashrc
_skillsym_complete() {
  local IFS=$'\\n'
  COMPREPLY=($(skillsym __complete "=\${COMP_WORDS[COMP_CWORD]}" "\${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null))
}
complete -o bashdefault -o default -F _skillsym_complete skillsym ssym`;

const ZSH = `# skillsym Tab completion for zsh (needs compinit, which most setups already run).
# Turn it on for good:
#   skillsym completion zsh >> ~/.zshrc
_skillsym() {
  local -a before items
  before=("\${(@)words[2,CURRENT-1]}")
  items=("\${(@f)$(skillsym __complete "=\${words[CURRENT]}" "\${before[@]}" 2>/dev/null)}")
  if (( \${#items[@]} )) && [[ -n "\${items[1]}" ]]; then
    compadd -a items
  else
    _files
  fi
}
compdef _skillsym skillsym ssym`;

export function completionScript(shell: string): string | undefined {
  return { powershell: POWERSHELL, bash: BASH, zsh: ZSH }[shell];
}
