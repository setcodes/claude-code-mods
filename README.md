# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code): small changes to its interface and behaviour, built on the mods (function hooks) API.

| Mod | What it does |
| --- | --- |
| [limit-watch](limit-watch) | A bar above the prompt with your 5-hour and weekly usage limits and time to reset; resumes the work after a limit resets; a stay-awake toggle on macOS. |

## Install a mod

In a terminal session of Claude Code with mods support (tested on 2.1.295 and 2.1.301):

```
/plugin install <mod> --marketplace setcodes/claude-code-mods
```

For example:

```
/plugin install limit-watch --marketplace setcodes/claude-code-mods
```

Answer `y` to add the marketplace, then pick the scope. Mods installed at the user scope also load in the desktop app's Code tab.

## Develop

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/` and `tests/`. Check one with:

```
claude plugin validate <mod>
claude plugin test <mod>
```

The mods API is early access and may change between Claude Code releases.

Author: Egor Maximov ([@setcodes](https://github.com/setcodes)). License: MIT.
