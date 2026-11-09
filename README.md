# Claude Desk

A small desktop wrapper for the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, built with Tauri 2.

It runs the real `claude` binary in a pseudo-terminal (via `portable-pty`) and renders it with xterm.js.
Every Claude Code feature — slash commands, permission prompts, plan mode, MCP, hooks — works the same as in your terminal.
The app adds a window around it:

- **Tabs or split view** – run several sessions, one at a time or side by side, stacked, or in a grid
  (switcher in the header bar, or ⌘\\ / Ctrl+Shift+\\ to cycle). Drag the dividers to resize panes
  (double-click a divider to even them out); double-click a pane's header or press ⌘↵ / Ctrl+Shift+↵ to
  maximise it.
- **Needs-attention alerts** – when a session you're not looking at finishes working (or rings the
  terminal bell / sends a notification), its tab and pane are badged and, if the window isn't focused,
  you get a desktop notification. Turn notifications off in Settings.
- **Resume conversations** – the New session dialog can start fresh, continue the latest conversation,
  or pick any earlier conversation in that folder (read from `~/.claude/projects`).
- **Paste images** – paste a screenshot (⌘V, or Ctrl+Shift+V) and it's saved to a temp file and its path
  is typed into the prompt, which Claude Code reads as an image.
- **Search** – ⌘F / Ctrl+Shift+F searches the terminal's scrollback.
- **Git branch** – each session's header shows the current branch.
- **Appearance** – dark, light or system theme; Cascadia Mono (default, 12 pt) or JetBrains Mono; compact, normal or relaxed line spacing. All in Settings.
- **Launch options** – folder picker, recent folders, model, permission mode, any extra args
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
| Search terminal | ⌘F | Ctrl+Shift+F |
| Maximise / restore pane | ⌘↵ | Ctrl+Shift+↵ |
| Cycle layout (tabs → side by side → stacked → grid) | ⌘\\ | Ctrl+Shift+\\ |
| Switch tab | Ctrl+Tab / Ctrl+Shift+Tab | same |
| Jump to tab N | ⌘1–9 | Ctrl+Shift+1–9 |
| Copy / paste (text or image) | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |

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
src-tauri/src/pty.rs   PTY spawn / write / resize / kill, flow control, `claude --version`
src-tauri/src/extras.rs  conversations, git branch, clipboard images
src/themes.ts          terminal colours for dark and light
src-tauri/src/lib.rs   Tauri setup
```

`src-tauri/src/extras.rs` lists past conversations, reads the git branch and saves pasted images.

Output streams from Rust to the webview as raw bytes over a Tauri `Channel`; keystrokes go back through the `pty_write` command.
Closing the app kills any running sessions.
