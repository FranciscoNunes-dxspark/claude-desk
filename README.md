# Claude Desk

A small desktop wrapper for the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, built with Tauri 2.

It runs the real `claude` binary in a pseudo-terminal (via `portable-pty`) and renders it with xterm.js.
Every Claude Code feature — slash commands, permission prompts, plan mode, MCP, hooks — works the same as in your terminal.
The app adds a window around it:

- **Tabs** – run several sessions side by side, each in its own project folder
- **Launch options** – folder picker, recent folders, model, permission mode, `--continue`, any extra args
- **Exit / restart** – a banner when Claude exits; Restart (or press Enter) to start again
- **Drag & drop** – drop files onto a session to insert their paths; drop a folder with no session running to start one there
- **CLI status** – shows the detected Claude Code version, or "CLI not found"
- **Shift+Enter** inserts a newline in the prompt; links are clickable

## Requirements

- Claude Code installed and logged in (`claude` works in your terminal)
- Rust (stable) and Node.js 18+
- Tauri platform prerequisites: https://v2.tauri.app/start/prerequisites/
  (Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev`)

## Run

```bash
npm install
npm run tauri dev
```

Build an installer (`.dmg` / `.msi` / `.deb` / `.AppImage`, depending on the OS):

```bash
npm run tauri build
```

## Installers

Pushing a tag such as `v0.1.0` (or using **Actions → Release → Run workflow**) builds installers
for macOS (Apple Silicon and Intel), Windows and Linux. The workflow attaches them to a **draft** release
under **Releases**; publish it when you're happy.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The builds aren't code-signed, so the first launch shows a warning:

- **macOS:** right-click the app → **Open** → **Open**. If it says the app is "damaged", run
  `xattr -cr "/Applications/Claude Desk.app"`.
- **Windows:** SmartScreen → **More info** → **Run anyway**.

## Shortcuts

| Action | macOS | Linux / Windows |
| --- | --- | --- |
| New session | ⌘T | Ctrl+Shift+T |
| Close session | ⌘W | Ctrl+Shift+W |
| Settings | ⌘, | Ctrl+Shift+, |
| Switch tab | Ctrl+Tab / Ctrl+Shift+Tab | same |
| Jump to tab N | ⌘1–9 | Ctrl+Shift+1–9 |
| Copy / paste | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |

Plain Ctrl+T, Ctrl+C and the like go to Claude Code itself.

## How `claude` is found

Apps launched from the Dock or Start menu don't inherit your shell's `PATH`, so the app:

1. uses the path set in **Settings → Claude binary**, if any; otherwise
2. on macOS/Linux, runs `claude` through your login shell (`$SHELL -l -c 'exec claude "$@"'`), so nvm/asdf/Homebrew paths apply;
   on Windows, through `cmd /C claude`;
3. and also adds the usual install locations (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, npm global) to `PATH`.

If the sidebar says **CLI not found**, run `which claude` (or `where claude`) in a terminal and paste the result into Settings.

## Layout

```
src/main.ts            UI: tabs, dialogs, xterm.js sessions
src/style.css
src-tauri/src/pty.rs   PTY spawn / write / resize / kill, `claude --version`
src-tauri/src/lib.rs   Tauri setup
```

Output streams from Rust to the webview as raw bytes over a Tauri `Channel`; keystrokes go back through the `pty_write` command.
Closing the app kills any running sessions.
