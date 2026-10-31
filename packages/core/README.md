# @skillsym/core

The library behind [skillsym](https://github.com/HypeNeutron/skillsym#readme): the hub, manifest and state files,
scanning agents' skills folders, and planning and applying changes (assign, sync, import, remove, eject).

Most people want the command line tool instead:

```bash
npx skillsym --help
```

This package has no terminal code: it never prompts or prints, and decisions that need a person (sync and import
conflicts) are returned as data with their choices, so other front ends can build on it.

MIT licensed.
