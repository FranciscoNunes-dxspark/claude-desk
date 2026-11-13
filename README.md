# Switchyard

A workspace for running [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions side by side,
built with Tauri 2. (Formerly Claude Desk.)

It runs the real `claude` binary in a pseudo-terminal (via `portable-pty`) and renders it with xterm.js.
Every Claude Code feature — slash commands, permission prompts, plan mode, MCP, hooks — works the same as in your terminal.
The app adds a window around it:

- **Tabs or split view** – run several sessions, one at a time or side by side, stacked, or in a grid
  (switcher in the header bar, or ⌘\\ / Ctrl+Shift+\\ to cycle). Drag the dividers to resize panes
  (double-click a divider to even them out); double-click a pane's header or press ⌘↵ / Ctrl+Shift+↵ to
  maximise it.
- **Exact session status** – each tab and pane shows *Working…*, *Needs permission*, *Has a question*,
  *Done* or *Ready*, straight from Claude Code (its OSC 7501 status reports), with the task's title.
- **Worktree per session** – start a session in its own git worktree and branch (Claude Code's
  `--worktree`), so parallel sessions on one repository don't edit the same files.
- **Changes panel** – the files the active session has changed, with +/− counts and a diff view
  (⌘G / Ctrl+Shift+G).
- **Documents panel** – the plans, markdown files and claude.ai artifacts the session's conversation
  produced, newest first: plans and markdown rendered (and kept current while Claude edits them),
  artifacts previewed in a sandboxed frame with a link to claude.ai. A session that writes a new one
  gets a badge (⌘D / Ctrl+Shift+D).
- **Broadcast** – send one prompt to several sessions at once (⌘J / Ctrl+Shift+J).
- **Command palette** – ⌘K / Ctrl+Shift+K to jump to a session or run any command. Rename sessions and
  give them a colour (double-click or right-click a tab); drag tabs to reorder them.
- **Conversation history** – search and reopen conversations from every project (⌘O / Ctrl+Shift+O).
- **Per-project defaults** – each folder remembers the model, permission mode and extra arguments you
  last used there.
- **Needs-attention alerts** – when a session you're not looking at finishes working (or rings the
  terminal bell / sends a notification), its tab and pane are badged and, if the window isn't focused,
  you get a desktop notification. Turn notifications off in Settings.
- **Resume conversations** – the New session dialog can start fresh, continue the latest conversation,
  or pick any earlier conversation in that folder (read from `~/.claude/projects`).
- **Paste images** – paste a screenshot (⌘V, or Ctrl+Shift+V) and it's saved to a temp file and its path
  is typed into the prompt, which Claude Code reads as an image.
- **Search** – ⌘F / Ctrl+Shift+F searches the terminal's scrollback.
- **Git branch** – each session's header shows the current branch.
- **Appearance** – dark, light or system theme; a choice of 13 bundled coding fonts — Cascadia Mono (default, 12 px), JetBrains Mono, Fira Code, Geist Mono, IBM Plex Mono, Source Code Pro, Iosevka, Commit Mono, Monaspace Neon, Victor Mono, Maple Mono, Roboto Mono, Ubuntu Mono — or any font installed on your computer; compact, normal or relaxed line spacing. All in Settings.
- **Reopens your workspace** – sessions, layout and the active session come back when the app starts,
  each continuing its own conversation (turn off in Settings).
- **Updates itself** – checks shortly after starting; when a new version is out, a toast offers
  **Install and restart**, and your sessions reopen afterwards. Settings → *Check for updates*.
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

## Tests

CI (`.github/workflows/ci.yml`) runs these on every pull request; the Rust tests on
Linux, Windows and macOS.

```bash
cd src-tauri && cargo test --release   # backend: pty I/O, flow control, status line, usage, git
npm run test:ui                        # the app in headless Chromium against a scripted backend
```

`npm run test:ui` needs Playwright's Chromium once: `npx playwright install chromium`.
Its scenarios are ways a session used to freeze, ignore input or end up in a wrong
state; each one fails on the code before its fix.

## Releases and updates

**Renamed from Claude Desk.** Installed copies of Claude Desk update to Switchyard like to any
other release. The identifier changed too (`com.dxspark.claudedesk` → `com.dxspark.switchyard`):
on its first launch the app copies its data (settings, open sessions, recent folders) from the
old identifier's folders before any window opens (`src-tauri/src/migrate.rs`); the old folders
are left as they were. On Windows the installer keys an install by its name, so Switchyard's
installer removes the old Claude Desk folder, shortcuts, uninstall entry and `claude-desk.exe`
(`src-tauri/windows/hooks.nsh`); a pinned taskbar shortcut may need pinning again.

Updates are looked for in this repository under its new name first, then its old one
(`claude-desk`), so renaming the repository on GitHub doesn't strand installed copies.

Releases work like Fleet's desktop window:

1. **Building.** Every push to `main` that changes the app runs the Release workflow, which builds the
   installers on macOS (Apple Silicon and Intel), Windows and Linux. *Actions → Release → Run workflow*
   runs it by hand.
2. **Versioning.** The version is the last `v…` release's patch plus one, or `tauri.conf.json`'s
   version when that's higher; raise it there for a minor or major version.
3. **Releasing.** Each run on `main` publishes `v<version>` as the latest release, with the installers,
   their signatures, and `latest.json`, which names the newest version and the file each platform installs.
4. **Checking.** Ten seconds after starting (and every 6 hours), the app reads
   `releases/latest/download/latest.json` (`tauri.conf.json` → `plugins.updater`). If it names a newer
   version, a toast says so.
5. **Installing.** *Install and restart* downloads it, checks its signature against the public key built
   into the app, refuses anything not signed with the matching private key, installs it and restarts.

The private key is the repository secret `TAURI_SIGNING_PRIVATE_KEY` (no password). Until that secret
exists, the workflow still builds the installers (download them from the run's *Artifacts*) but doesn't
release them, and says so in its log. **Losing the private key means installed copies can't be updated
any more**: they'd need reinstalling with a build that has a new key pair
(`npx tauri signer generate`, and the new public key in `tauri.conf.json`).

The app downloads updates without a GitHub login, so **the releases must be public** — as with Fleet,
whose repository is public. On Linux, only the AppImage updates itself; `.deb`/`.rpm` installs are
updated with the package manager.

The builds aren't code-signed, so the first launch shows a warning:

- **macOS:** right-click the app → **Open** → **Open**. If it says the app is "damaged", run
  `xattr -cr "/Applications/Switchyard.app"`.
- **Windows:** SmartScreen → **More info** → **Run anyway**.

## Shortcuts

| Action | macOS | Linux / Windows |
| --- | --- | --- |
| New session | ⌘T | Ctrl+Shift+T |
| Close session | ⌘W | Ctrl+Shift+W |
| Settings | ⌘, | Ctrl+Shift+, |
| Search terminal | ⌘F | Ctrl+Shift+F |
| Collapse / expand sidebar | ⌘B | Ctrl+Shift+B |
| Command palette | ⌘K | Ctrl+Shift+K |
| Changes panel | ⌘G | Ctrl+Shift+G |
| Documents panel | ⌘D | Ctrl+Shift+D |
| Broadcast a prompt | ⌘J | Ctrl+Shift+J |
| Conversation history | ⌘O | Ctrl+Shift+O |
| Maximise / restore pane | ⌘↵ | Ctrl+Shift+↵ |
| Cycle layout (tabs → side by side → stacked → grid) | ⌘\\ | Ctrl+Shift+\\ |
| Switch tab | Ctrl+Tab / Ctrl+Shift+Tab | same |
| Jump to tab N | ⌘1–9 | Ctrl+Shift+1–9 |
| Copy / paste (text or image) | ⌘C / ⌘V | Windows: Ctrl+C (with a selection) / Ctrl+V, or Ctrl+Shift+C / Ctrl+Shift+V. Linux: Ctrl+Shift+C / Ctrl+Shift+V |

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
src-tauri/src/extras.rs  conversations (per folder and across projects), git branch, clipboard images
src-tauri/src/git.rs     worktree paths, changed files and diffs for the changes panel
src-tauri/src/docs.rs    plans, markdown files and artifacts a conversation produced; artifact previews
scripts/                 release version and latest.json (used by the Release workflow)
src/themes.ts          terminal colours for dark and light
src-tauri/src/lib.rs   Tauri setup
```

`src-tauri/src/extras.rs` lists past conversations, reads the git branch and saves pasted images.

Output streams from Rust to the webview as raw bytes over a Tauri `Channel`; keystrokes go back through the `pty_write` command.
Closing the app kills any running sessions.
