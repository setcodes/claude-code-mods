# limit-watch

A mod for [Claude Code](https://claude.com/claude-code). It shows your usage limits above the prompt and, if a limit stops your work, picks it back up after the limit resets.

```
🕓 5h 67% reset 3h 14m    📅 week 85% reset 15h 54m     ● [Resume after reset] [Zzz]  Hide
```

## Install

You need Claude Code **2.1.295 or newer** (`claude --version`; update with `claude update`). Then run this in your terminal:

```bash
claude plugin install limit-watch --marketplace setcodes/claude-code-mods
```

Open a new Claude Code session — in the terminal or in the desktop app's **Code** tab — and the bar appears above the prompt. Other ways to install, and how to update or remove the mod: see the [repository README](../README.md#install-a-mod).

## How to use it

**Read your limits.** The bar shows the 5-hour and weekly windows: how much is used and when each one resets. Numbers are grey below 50%, yellow from 50%, red from 80%. On a narrow window — say, with a side panel open — the bar keeps just the icons and percentages; if even that doesn't fit, the buttons move to a second row.

**Let Claude continue after a limit.** Click **Resume after reset** — the dot next to it turns green. From now on, if Claude stops in the middle of work because a limit ran out, the mod waits until the limit resets (plus one minute) and sends the chat a message with your last request and Claude's last reply, so Claude carries on where it stopped. While it waits, **Resume now** and **Cancel** replace the button; the reset times next to the limits show when it will continue.

What it will not do:

- It does nothing if a limit was reached by an answer that finished — there is nothing to continue.
- It cancels itself if the chat continues some other way, for example when you write a message. No duplicates.
- If the weekly limit runs out and resets more than 6 hours later, it asks first: **Resume in …** or **No thanks**.
- It stops after 3 automatic tries in a row that hit the limit again.
- It only works while the app and this chat stay open.

**Keep the Mac awake (macOS).** Click **Zzz** to stop the Mac from falling asleep while this chat is open, so it is awake when the limit resets. Click it again to allow sleep. Closing the laptop lid still puts the Mac to sleep.

**Hide the bar.** Click **Hide**. To bring it back, type `/limit-watch`.

## Commands

| Command | What it does |
| --- | --- |
| `/limit-watch` | Hide or show the bar. |
| `/limit-watch test 1m` | Try resuming without waiting for a real limit: in one minute the mod sends a real resume message to the chat. Use `30s`, `5m`, `2h` for other delays. |

## Language

The bar uses your system language: English, Russian, Spanish, German, French, Portuguese, Chinese (simplified), Japanese or Ukrainian; anything else gets English. To pick a language yourself, add this to `~/.claude/settings.json` (inside the outer `{ }`) and start a new session:

```json
"pluginConfigs": {
  "limit-watch@claude-code-mods": { "options": { "language": "en" } }
}
```

Use `auto`, `en`, `ru`, `es`, `de`, `fr`, `pt`, `zh`, `ja` or `uk`. If the file already has a `"pluginConfigs"` block, add only the `limit-watch@claude-code-mods` line inside it.

## If something doesn't work

- **`Unknown command: /limit-watch` or no bar** — the session was started before the mod was installed. Start a new one. Check that the mod is on with `claude plugin list`: `limit-watch@claude-code-mods` should show `✔ enabled`.
- **Still nothing** — check `claude --version` is 2.1.295 or newer.
- **No `Zzz` button** — it exists only on macOS.

## For developers

From the repository root:

```bash
claude plugin validate limit-watch
claude plugin test limit-watch
```

Translations were not checked by native speakers — corrections are welcome. Icons: [Lucide](https://lucide.dev) (ISC).

Author: Egor Maximov ([@setcodes](https://github.com/setcodes)). License: MIT (see the repository root).
