# Releasing

Steps marked **(maintainer)** publish something or need an account; do them yourself.

## Before

1. `main` is green in CI (Windows, macOS, Linux × Node 20 and 24).
2. Versions match in `packages/core/package.json` and `packages/cli/package.json`, and `CHANGELOG.md` has a
   section for this version.
3. Pack and try the packages from a clean folder, with a throwaway home so your real agent folders are not touched:

   ```bash
   pnpm -r build
   (cd packages/core && pnpm pack --pack-destination ../../.release)
   (cd packages/cli && pnpm pack --pack-destination ../../.release)
   ```

   Install both tarballs into an empty folder (`npm install <core>.tgz <cli>.tgz`), set `HOME`/`USERPROFILE` and
   `SKILLSYM_HOME` to a temporary folder, and run the README quickstart. `skillsym --version` must print the new
   version. `pnpm pack` turns the `workspace:*` dependency into the exact version, and `prepack` copies `LICENSE`
   (and the README for the CLI) into each package.

## Publish

4. **(maintainer)** The first time only:
   - make the GitHub repository public (the README links to its issues);
   - create the npm organization `skillsym` (free for public packages), which owns the `@skillsym/core` name;
   - `npm login`.
5. **(maintainer)** Publish core first, then the CLI, which depends on it:

   ```bash
   cd packages/core && pnpm publish --access public
   cd ../cli && pnpm publish --access public
   ```

6. **(maintainer)** Tag and push: `git tag v0.1.0 && git push origin v0.1.0`.
7. Check from a clean machine or folder: `npx skillsym@0.1.0 --version` on Windows, macOS and Linux.
8. Replace `unreleased` with the date in `CHANGELOG.md`.
