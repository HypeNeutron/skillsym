// Runs before `pnpm pack` / `pnpm publish` in each package: put the LICENSE (and, for the CLI, the
// project README) next to package.json, so the npm package carries them. The copies are not committed.
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = process.cwd();

copyFileSync(path.join(root, "LICENSE"), path.join(pkg, "LICENSE"));
// The CLI's npm page shows the project README; the core package keeps its own short README.
if (path.basename(pkg) === "cli") copyFileSync(path.join(root, "README.md"), path.join(pkg, "README.md"));
if (!existsSync(path.join(pkg, "dist", "index.js"))) {
  console.error(`prepack: ${pkg}/dist is missing; run \`pnpm build\` first.`);
  process.exit(1);
}
