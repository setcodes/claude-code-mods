# claude-code-mods

Mods for [Claude Code](https://claude.com/claude-code) — small add-ons that change how Claude Code looks and behaves.

| Mod | What it does |
| --- | --- |
| [limit-watch](limit-watch) | Shows your 5-hour and weekly usage limits above the prompt, picks the work back up after a limit resets, and can keep a Mac awake while it waits. |

## Before you start

You need **Claude Code 2.1.295 or newer** — mods are a new, early-access feature. Check your version in a terminal:

```bash
claude --version
```

If it is older, update it:

```bash
claude update
```

## Install a mod

Pick **one** of the two ways. Both use the terminal, not the desktop app.

**A. One command in your terminal** (Claude Code 2.1.292 or newer):

```bash
claude plugin install limit-watch --marketplace setcodes/claude-code-mods
```

**B. Inside Claude Code.** Start it with `claude`, then type:

```
/plugin install limit-watch --marketplace setcodes/claude-code-mods
```

Answer `y` when asked to add the marketplace, then choose the **User** scope so the mod works in every project.

That's it: the mod is on in every new Claude Code session, in the terminal and in the desktop app's **Code** tab. `/plugin install` doesn't work in the desktop app — install once from the terminal, then open a new session in the app.

## Update, turn off, remove

```bash
claude plugin update limit-watch@claude-code-mods
claude plugin disable limit-watch@claude-code-mods
claude plugin enable limit-watch@claude-code-mods
claude plugin uninstall limit-watch@claude-code-mods
```

After an update, start a new session to load the new version. Updates are not installed automatically.

## For mod authors

Each mod is a folder with `.claude-plugin/plugin.json`, `hooks/` and `tests/`. From the repository root:

```bash
claude plugin validate limit-watch
claude plugin test limit-watch
```

The mods API is early access and may change between Claude Code releases.

Author: Egor Maximov ([@setcodes](https://github.com/setcodes)). License: MIT.
