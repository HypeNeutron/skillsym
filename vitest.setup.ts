// Pin the git settings the tests depend on, whatever the machine's global git config says. CI runners
// differ from dev machines: Windows runners set core.autocrlf=true (checkouts turn "v1\n" into "v1\r\n"),
// and older git defaults new repositories to "master". GIT_CONFIG_* reaches every git the tests start,
// including the ones run by CLI child processes, which inherit process.env.
const pinned: [string, string][] = [
  ["core.autocrlf", "false"],
  ["init.defaultBranch", "main"],
];
const start = Number(process.env.GIT_CONFIG_COUNT ?? 0) || 0;
pinned.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${start + i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${start + i}`] = value;
});
process.env.GIT_CONFIG_COUNT = String(start + pinned.length);
