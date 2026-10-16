# limit-watch

A mod for [Claude Code](https://claude.com/claude-code): a bar above the prompt that shows your usage limits and can pick the work back up when a limit resets.

```
⏱ 5h 67% reset 3h 14m    📅 week 85% reset 15h 54m     ● [Resume after reset] [Zzz]  Hide
```

- **Limits at a glance** — 5-hour and weekly windows with percent used and time to reset. Grey below 50%, yellow from 50%, red from 80%.
- **Resume after reset** — when a window hits 100%, the mod waits for the reset (plus a minute) and sends the session a message that quotes your last request and the agent's last reply, so the work continues where it stopped.
  - Cancels itself if you continue by hand, so there is no duplicate.
  - A far reset (the weekly window, more than 6 hours away) is only scheduled after you confirm it.
  - Checks the wall clock every 30 seconds, so a Mac that slept still resumes right after it wakes.
- **Zzz — stay awake** (macOS) — runs `caffeinate -i` while this chat is open, so the Mac does not idle-sleep before the reset. A closed lid still sleeps the Mac.
- **Languages** — English, Russian, Spanish, German, French, Portuguese, Chinese (simplified), Japanese, Ukrainian. Picked from the OS language, or set `language` in the plugin options.

## Install

In a terminal session of Claude Code (a version with mods support):

```
/plugin install limit-watch --marketplace setcodes/claude-code-mods
```

Answer `y` to add the marketplace, then pick the scope (user scope = every session). The `language` option defaults to `auto` (the OS language); change it later with `/plugin configure limit-watch@limit-watch`. The bar appears in that session at once, and in the desktop app's Code tab for sessions started afterwards.

## Commands

- `/limit-watch` — hide or show the bar.
- `/limit-watch test 1m` — check resuming end to end: in one minute the mod sends a real resume message to the chat.

## Limits of the mod API

- The resume timer lives in the Claude Code process: if the app or chat is closed, nothing resumes.
- `Zzz` is shown on macOS only.
- The mod API is early access and may change between Claude Code releases.

## Develop

```
claude plugin validate .
claude plugin test .
```

Translations were not checked by native speakers — corrections are welcome. Icons: [Lucide](https://lucide.dev) (ISC).

License: MIT (see the repository root).
