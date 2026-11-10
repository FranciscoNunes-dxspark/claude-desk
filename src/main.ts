import "@xterm/xterm/css/xterm.css";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/cascadia-mono/400.css";
import "@fontsource/cascadia-mono/600.css";
import "./style.css";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

import { SEARCH_DECORATIONS, TERMINAL_THEMES, type ThemeName } from "./themes";

// ---------- persisted settings ----------

type ThemePref = "system" | ThemeName;
type ConversationMode = "new" | "continue" | "resume";

type TerminalFont = "Cascadia Mono" | "JetBrains Mono";
const TERMINAL_FONTS: TerminalFont[] = ["Cascadia Mono", "JetBrains Mono"];
const fontStack = (f: TerminalFont) => `"${f}", ui-monospace, Menlo, Consolas, monospace`;

interface Settings {
  binary: string;
  font: TerminalFont;
  /** Terminal font size in pixels. */
  fontSize: number;
  lineHeight: number;
  /** Settings schema version, for migrating old defaults. */
  v?: number;
  theme: ThemePref;
  notifications: boolean;
  /** Reopen last session's workspace on launch. */
  restore: boolean;
}

interface LaunchOptions {
  cwd: string;
  model: string;
  permissionMode: string;
  conversation: ConversationMode;
  resumeId?: string;
  resumeTitle?: string;
  /** Claude Code's id for this session's conversation, so it can be reopened exactly. */
  conversationId?: string;
  extra: string;
}

interface Conversation {
  id: string;
  title: string;
  prompts: number;
  modifiedMs: number;
}

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  },
  getList(key: string): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};

let settings: Settings = store.get<Settings>("settings", {
  binary: "",
  font: "Cascadia Mono",
  fontSize: 12,
  lineHeight: 1,
  theme: "dark",
  notifications: true,
  restore: true,
});
// v1 saved the old default size (13) with every setting; move it to the new default.
if ((settings.v ?? 1) < 2) {
  if (settings.fontSize === 13) settings.fontSize = 12;
  settings.v = 2;
}
// Sizes are in pixels. A build that briefly stored points (v3: 12 kept as 12, others
// converted px → pt) is converted back.
if (settings.v === 3 && settings.fontSize !== 12) settings.fontSize = Math.round((settings.fontSize * 4) / 3);
if ((settings.v ?? 1) < 4) settings.v = 4;
if (!TERMINAL_FONTS.includes(settings.font)) settings.font = "Cascadia Mono";

/** The terminal font size in CSS pixels. */
const fontPx = () => settings.fontSize;

type SavedLaunch = Omit<LaunchOptions, "cwd" | "resumeId" | "resumeTitle"> & { continueLast?: boolean };
let lastLaunch: SavedLaunch = store.get<SavedLaunch>("lastLaunch", {
  model: "",
  permissionMode: "",
  conversation: "new",
  extra: "",
});
// Older versions stored a "continue" checkbox; resume is per-folder so never default to it.
if (lastLaunch.continueLast) lastLaunch.conversation = "continue";
if (lastLaunch.conversation !== "continue") lastLaunch.conversation = "new";
delete lastLaunch.continueLast;

function recentFolders(): string[] {
  return store.getList("recent");
}
function pushRecent(dir: string) {
  store.set("recent", [dir, ...recentFolders().filter((d) => d !== dir)].slice(0, 8));
}

// ---------- helpers ----------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const isMac = navigator.platform.toUpperCase().includes("MAC");
const isWindows = navigator.platform.toUpperCase().startsWith("WIN");
const icon = (name: string) => `<svg class="ic"><use href="#i-${name}" /></svg>`;

function basename(p: string) {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Split a string into args, honouring single and double quotes. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1]?.replace(/\\(.)/g, "$1") ?? m[2] ?? m[3]);
  return out;
}

/**
 * Arguments for `claude`. Every session has its own conversation id: a new one
 * is started with `--session-id <id>`; once Claude Code has saved it, restarts
 * and restored workspaces reopen it with `--resume <id>`.
 */
function buildArgs(o: LaunchOptions, conversationSaved: boolean): string[] {
  const args: string[] = [];
  if (o.model) args.push("--model", o.model);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.conversationId) args.push(conversationSaved ? "--resume" : "--session-id", o.conversationId);
  else if (o.conversation === "continue") args.push("--continue");
  else if (o.conversation === "resume" && o.resumeId) args.push("--resume", o.resumeId);
  return args.concat(splitArgs(o.extra));
}

/** Gives a session its conversation id the first time it starts. */
async function assignConversation(o: LaunchOptions) {
  if (o.conversationId) return;
  if (o.conversation === "resume" && o.resumeId) o.conversationId = o.resumeId;
  else if (o.conversation === "continue") {
    const list = await invoke<Conversation[]>("list_conversations", { cwd: o.cwd }).catch(() => []);
    o.conversationId = list[0]?.id;
  }
  o.conversationId ??= crypto.randomUUID();
  saveWorkspace();
}

function shellQuote(path: string) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

function timeAgo(ms: number) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
}

function toast(where: HTMLElement, message: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = message;
  where.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- theme ----------

const prefersLight = matchMedia("(prefers-color-scheme: light)");

function resolvedTheme(): ThemeName {
  if (settings.theme === "system") return prefersLight.matches ? "light" : "dark";
  return settings.theme;
}

function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  for (const s of sessions) s.term.options.theme = TERMINAL_THEMES[t];
  void getCurrentWindow()
    .setTheme(settings.theme === "system" ? null : t)
    .catch(() => {});
}
prefersLight.addEventListener("change", () => settings.theme === "system" && applyTheme());

// ---------- attention & notifications ----------

let windowFocused = document.hasFocus();
let notifyPermission: boolean | null = null;

async function desktopNotify(title: string, body: string) {
  void getCurrentWindow().requestUserAttention(UserAttentionType.Informational).catch(() => {});
  if (!settings.notifications) return;
  try {
    if (notifyPermission === null) {
      notifyPermission = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    }
    if (notifyPermission) sendNotification({ title, body });
  } catch {
    /* notifications unavailable on this system */
  }
}

function updateAttentionBadge() {
  const n = sessions.filter((s) => s.attention).length;
  void getCurrentWindow()
    .setBadgeCount(n || undefined)
    .catch(() => {});
}

/** A session goes quiet this long after a burst of work → it's waiting for you. */
const QUIET_MS = 2500;
/** Ignore short bursts (startup banner, a quick redraw). */
const MIN_BURST_MS = 3000;

setInterval(() => {
  const now = performance.now();
  for (const s of sessions) s.checkIdle(now);
}, 1000);

// ---------- sessions ----------

class Session {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  readonly tab: HTMLLIElement;
  attention = false;
  branch: string | null = null;
  private ptyId: number | null = null;
  private restartPending = false;
  private banner: HTMLDivElement | null = null;
  private resizeObs: ResizeObserver;
  private burstStart = 0;
  private lastOutput = 0;
  private burstAlerted = true;

  constructor(readonly opts: LaunchOptions) {
    this.el = document.createElement("div");
    this.el.className = "term";
    this.el.innerHTML = `
      <div class="pane-head" title="Double-click to maximise">
        <span class="dot"></span>
        <span class="pane-name"></span>
        <span class="pane-path"></span>
        <span class="branch" hidden></span>
        <span class="chips-row"></span>
        <button class="icon-btn" data-act="zoom" title="Maximise">${icon("max")}</button>
        <button class="icon-btn" data-act="restart" title="Restart session">${icon("restart")}</button>
        <button class="icon-btn" data-act="close" title="Close session">${icon("x")}</button>
      </div>
      <div class="term-body"><div class="term-host"></div></div>`;
    this.el.querySelector(".pane-name")!.textContent = basename(opts.cwd);
    this.el.querySelector(".pane-path")!.textContent = opts.cwd;
    this.el.querySelector(".chips-row")!.append(...chipsFor(opts));
    this.el.querySelector('[data-act="zoom"]')!.addEventListener("click", () => toggleZoom(this));
    this.el.querySelector('[data-act="restart"]')!.addEventListener("click", () => this.restart());
    this.el.querySelector('[data-act="close"]')!.addEventListener("click", () => closeSession(this));
    this.el.querySelector(".pane-head")!.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest("button")) toggleZoom(this);
    });
    // Clicking anywhere in a pane makes it the active session.
    this.el.addEventListener("mousedown", () => active !== this && activate(this, false));
    this.body = this.el.querySelector(".term-body")!;
    $("#terminals").appendChild(this.el);

    this.term = new Terminal({
      fontFamily: fontStack(settings.font),
      fontSize: fontPx(),
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: settings.lineHeight,
      cursorStyle: "bar",
      cursorWidth: 2,
      minimumContrastRatio: 1,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      macOptionIsMeta: true,
      theme: TERMINAL_THEMES[resolvedTheme()],
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    // Open into an unpadded host: FitAddon measures the parent including
    // padding, so padding on the parent would make it propose too many rows/cols.
    this.term.open(this.body.querySelector<HTMLDivElement>(".term-host")!);
    // The canvas renderer draws block and box-drawing characters itself, so
    // Claude's logo and borders join up exactly instead of depending on the
    // font (the DOM renderer leaves gaps between rows and mixes fallback fonts).
    try {
      this.term.loadAddon(new CanvasAddon());
    } catch {
      /* canvas unavailable: keep the DOM renderer */
    }
    this.term.textarea?.addEventListener("focus", () => active !== this && activate(this, false));

    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    this.term.onData((data) => this.write(data));
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId != null) void invoke("pty_resize", { id: this.ptyId, cols, rows }).catch(() => {});
    });
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(this.body);

    // Explicit "look at me" signals: terminal bell and OSC 9 / OSC 777 notifications.
    this.term.onBell(() => this.flagAttention("needs your attention"));
    this.term.parser.registerOscHandler(9, (data) => {
      // OSC 9;4 is a progress report, not a notification.
      if (!/^4;/.test(data)) this.flagAttention("needs your attention", data);
      return true;
    });
    this.term.parser.registerOscHandler(777, (data) => {
      const [kind, title, body] = data.split(";");
      if (kind === "notify") this.flagAttention(title || "needs your attention", body);
      return true;
    });

    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (this === active) {
        $("#search-count").textContent =
          resultCount === 0 ? "No results" : resultIndex >= 0 ? `${resultIndex + 1} of ${resultCount}` : `${resultCount}`;
      }
    });

    // Pasting an image saves it to a file and types its path, which Claude Code reads.
    this.body.addEventListener(
      "paste",
      (e) => {
        const dt = e.clipboardData;
        const hasImage = [...(dt?.items ?? [])].some((i) => i.kind === "file" && i.type.startsWith("image/"));
        const hasText = !!dt?.getData("text/plain");
        if (hasImage || !hasText) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void this.pasteImage(!hasImage);
        }
      },
      true,
    );

    this.tab = document.createElement("li");
    this.tab.innerHTML = `
      <span class="dot"></span>
      <span class="initial"></span>
      <span class="meta"><span class="name"></span><span class="path"></span></span>
      <kbd></kbd>
      <button class="icon-btn close" title="Close session">${icon("x")}</button>`;
    this.tab.querySelector(".name")!.textContent = basename(opts.cwd);
    this.tab.querySelector(".initial")!.textContent = (basename(opts.cwd).match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
    this.tab.querySelector(".path")!.textContent = `\u200E${opts.cwd}\u200E`;
    this.tab.title = `${basename(opts.cwd)} — ${opts.cwd}`;
    this.tab.addEventListener("click", () => activate(this));
    this.tab.querySelector(".close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(this);
    });
    $("#tabs").appendChild(this.tab);

    this.term.onTitleChange((t) => {
      if (t) this.tab.querySelector(".path")!.textContent = `\u200E${t}\u200E`;
    });
  }

  get running() {
    return this.ptyId != null;
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    // Shift+Enter → newline in Claude's prompt (sent as Meta+Enter).
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.write("\x1b\r");
      e.preventDefault();
      return false;
    }
    const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
    // Copy: Ctrl+Shift+C on Linux & Windows; on Windows also plain Ctrl+C while text is
    // selected, as in Windows Terminal (without a selection Ctrl+C still interrupts).
    if (!isMac && e.ctrlKey && e.code === "KeyC" && (e.shiftKey || (isWindows && plainCtrl && this.term.hasSelection()))) {
      const sel = this.term.getSelection();
      if (sel) void this.copy(sel);
      if (!e.shiftKey) this.term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Paste: Ctrl+Shift+V on Linux & Windows; on Windows also plain Ctrl+V, as in
    // Windows Terminal. (On Linux plain Ctrl+V stays with Claude Code, which uses it to
    // paste images itself.) An image on the clipboard is saved and its path typed.
    if (!isMac && e.ctrlKey && e.code === "KeyV" && (e.shiftKey || (isWindows && plainCtrl))) {
      e.preventDefault();
      void this.pasteClipboard();
      return false;
    }
    // Let app-level shortcuts bubble instead of going to the pty.
    if (isAppShortcut(e)) return false;
    return true;
  }

  /** Pastes the clipboard: an image as a saved file's path, otherwise its text. */
  async pasteClipboard() {
    if (await this.pasteImage(false)) return;
    const text = await invoke<string | null>("read_clipboard_text").catch(() => null);
    if (text) this.term.paste(text);
    else toast(this.el, "Nothing to paste");
  }

  async copy(text: string) {
    try {
      await invoke("write_clipboard_text", { text });
    } catch {
      await navigator.clipboard.writeText(text).catch(() => {});
    }
    toast(this.el, "Copied");
  }

  /** Saves a clipboard image to a temp file and types its path. Returns false if there was none. */
  async pasteImage(reportMissing: boolean): Promise<boolean> {
    try {
      const path = await invoke<string | null>("save_clipboard_image");
      if (path) {
        this.write(shellQuote(path) + " ");
        toast(this.el, "Image pasted");
        this.term.focus();
        return true;
      }
    } catch (err) {
      toast(this.el, `Couldn't paste image: ${err}`);
      return true;
    }
    if (reportMissing) toast(this.el, "Nothing to paste");
    return false;
  }

  refit() {
    if (resizingPanes || this.body.offsetParent === null) return; // hidden or mid-drag
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  write(data: string) {
    if (this.ptyId == null) {
      // Enter restarts an exited session.
      if (data === "\r") void this.start();
      return;
    }
    void invoke("pty_write", { id: this.ptyId, data }).catch(() => {});
  }

  private noteOutput() {
    const now = performance.now();
    if (now - this.lastOutput > QUIET_MS / 2) {
      this.burstStart = now;
      this.burstAlerted = false;
    }
    this.lastOutput = now;
  }

  /** Called every second: a burst of work followed by silence means Claude is waiting. */
  checkIdle(now: number) {
    if (this.burstAlerted || !this.running) return;
    if (now - this.lastOutput >= QUIET_MS) {
      this.burstAlerted = true;
      if (this.lastOutput - this.burstStart >= MIN_BURST_MS) this.flagAttention("is waiting for you");
    }
  }

  flagAttention(what: string, detail?: string) {
    const seen = windowFocused && active === this;
    if (seen || this.attention) return;
    this.attention = true;
    this.tab.dataset.attention = "1";
    this.el.dataset.attention = "1";
    updateAttentionBadge();
    if (!windowFocused) void desktopNotify(`${basename(this.opts.cwd)}: Claude ${what}`, detail || this.opts.cwd);
  }

  clearAttention() {
    if (!this.attention) return;
    this.attention = false;
    delete this.tab.dataset.attention;
    delete this.el.dataset.attention;
    updateAttentionBadge();
  }

  setBranch(branch: string | null) {
    if (branch === this.branch) return;
    this.branch = branch;
    const el = this.el.querySelector<HTMLElement>(".branch")!;
    el.hidden = !branch;
    el.innerHTML = branch ? `${icon("branch")}<span></span>` : "";
    if (branch) el.querySelector("span")!.textContent = branch;
    if (this === active) updateTopbar();
  }

  async start() {
    if (this.banner) {
      // Restarting: clear the previous run's screen so the new TUI draws cleanly.
      this.banner.remove();
      this.banner = null;
      this.term.reset();
    }
    this.refit();
    this.setStatus("running");

    const onData = new Channel<ArrayBuffer | number[]>();
    // Flow control: acknowledge bytes once xterm has processed them. The
    // backend stops reading when 1 MB is unacknowledged, so a flood of output
    // can't pile up in memory faster than it can be drawn.
    const ACK_EVERY = 64 << 10;
    let processed = 0;
    onData.onmessage = (chunk) => {
      const bytes = new Uint8Array(chunk);
      this.noteOutput();
      this.term.write(bytes, () => {
        processed += bytes.length;
        if (processed >= ACK_EVERY && this.ptyId != null) {
          void invoke("pty_ack", { id: this.ptyId, bytes: processed }).catch(() => {});
          processed = 0;
        }
      });
    };
    const onExit = new Channel<{ code: number | null }>();
    onExit.onmessage = ({ code }) => this.exited(code);

    try {
      this.ptyId = await invoke<number>("pty_spawn", {
        cwd: this.opts.cwd,
        args: buildArgs(
          this.opts,
          await invoke<boolean>("conversation_exists", { cwd: this.opts.cwd, id: this.opts.conversationId }).catch(
            () => false,
          ),
        ),
        binary: settings.binary || null,
        cols: this.term.cols,
        rows: this.term.rows,
        onData,
        onExit,
      });
      // The pane may have been resized while the process was starting (resize
      // events are dropped until we have an id), so sync the size once more.
      this.refit();
      void invoke("pty_resize", { id: this.ptyId, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    } catch (err) {
      this.term.write(`\r\n\x1b[31mCould not start Claude Code:\x1b[0m ${err}\r\n`);
      this.exited(null);
    }
  }

  restart() {
    if (this.ptyId == null) return void this.start();
    this.restartPending = true;
    void invoke("pty_kill", { id: this.ptyId }).catch(() => {});
  }

  private exited(code: number | null) {
    this.ptyId = null;
    if (this.restartPending) {
      this.restartPending = false;
      this.term.reset();
      return void this.start();
    }
    this.setStatus(code === 0 ? "exited" : "error");
    this.flagAttention(code === 0 ? "session ended" : "exited with an error");
    this.banner = document.createElement("div");
    this.banner.className = code === 0 ? "banner" : "banner error";
    this.banner.innerHTML = `<span class="msg"></span>
      <button class="btn primary">${icon("restart")} Restart</button>
      <button class="btn">Close</button>`;
    this.banner.querySelector(".msg")!.textContent =
      code == null ? "Session ended" : `Claude exited with code ${code}`;
    const [restart, close] = this.banner.querySelectorAll("button");
    restart.addEventListener("click", () => void this.start());
    close.addEventListener("click", () => closeSession(this));
    this.el.appendChild(this.banner);
  }

  private setStatus(s: "running" | "exited" | "error") {
    this.tab.dataset.status = s;
    this.el.dataset.status = s;
    if (active === this) updateTopbar();
  }

  dispose() {
    if (this.ptyId != null) void invoke("pty_kill", { id: this.ptyId }).catch(() => {});
    this.resizeObs.disconnect();
    this.term.dispose();
    this.el.remove();
    this.tab.remove();
  }
}

const sessions: Session[] = [];
let active: Session | null = null;

// ---------- layouts, resizable panes, maximise ----------

type Layout = "tabs" | "columns" | "rows" | "grid";
const LAYOUTS: Layout[] = ["tabs", "columns", "rows", "grid"];
const LAYOUT_NAMES: Record<Layout, string> = { tabs: "Tabs", columns: "Side by side", rows: "Stacked", grid: "Grid" };
let layout: Layout = LAYOUTS.includes(store.getList("layout")[0] as Layout)
  ? (store.getList("layout")[0] as Layout)
  : "tabs";

/** The pane shown full-size in a split layout, if any. */
let zoomed: Session | null = null;
/** Relative sizes of the grid's columns and rows (fr units). */
let colWeights: number[] = [1];
let rowWeights: number[] = [1];
let gridCols = 1;
let gridRows = 1;
let resizingPanes = false;
const GAP = 1;
const MIN_PANE_PX = 180;

function isSplit() {
  return layout !== "tabs" && sessions.length > 1;
}

function setLayout(l: Layout) {
  layout = l;
  zoomed = null;
  store.set("layout", [l]);
  applyLayout();
  if (active) activate(active);
}

function toggleZoom(s: Session) {
  if (!isSplit()) return;
  zoomed = zoomed === s ? null : s;
  applyLayout();
  activate(s);
}

const template = (weights: number[]) => weights.map((w) => `minmax(0, ${w}fr)`).join(" ");

function applyLayout() {
  const box = $("#terminals");
  const n = sessions.length;
  const split = isSplit();
  if (zoomed && (!split || !sessions.includes(zoomed))) zoomed = null;

  gridCols = 1;
  gridRows = 1;
  if (split && layout === "columns") gridCols = n;
  if (split && layout === "rows") gridRows = n;
  if (split && layout === "grid") {
    gridCols = Math.ceil(Math.sqrt(n));
    gridRows = Math.ceil(n / gridCols);
  }
  // Keep custom sizes while the shape stays the same; reset when it changes.
  if (colWeights.length !== gridCols) colWeights = Array(gridCols).fill(1);
  if (rowWeights.length !== gridRows) rowWeights = Array(gridRows).fill(1);

  box.className = !split ? "tabs" : zoomed ? "split zoom" : `split ${layout}`;
  box.style.gridTemplateColumns = zoomed ? "minmax(0, 1fr)" : template(colWeights);
  box.style.gridTemplateRows = zoomed ? "minmax(0, 1fr)" : template(rowWeights);
  sessions.forEach((x, i) => {
    // In a grid with a short last row, stretch the final pane across the gap.
    const last = i === n - 1;
    x.el.style.gridColumn = split && !zoomed && layout === "grid" && last ? `${(i % gridCols) + 1} / -1` : "";
    x.el.classList.toggle("zoomed", x === zoomed);
    const zb = x.el.querySelector<HTMLButtonElement>('[data-act="zoom"]')!;
    zb.innerHTML = icon(x === zoomed ? "restore" : "max");
    zb.title = x === zoomed ? "Restore layout" : "Maximise";
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("#layout-switch button")) {
    b.classList.toggle("on", b.dataset.layout === layout);
  }
  document.body.classList.toggle("is-split", split);
  renderSplitters();
  updateTopbar();
  requestAnimationFrame(() => sessions.forEach((x) => x.refit()));
}

/** Pixel sizes of tracks that share `total` px (minus gaps) by weight. */
function trackSizes(weights: number[], total: number) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const free = total - (weights.length - 1) * GAP;
  return weights.map((w) => (free * w) / sum);
}

function renderSplitters() {
  const box = $("#terminals");
  box.querySelectorAll(".splitter").forEach((e) => e.remove());
  if (!isSplit() || zoomed) return;
  const W = box.clientWidth;
  const H = box.clientHeight;
  const cols = trackSizes(colWeights, W);
  const rows = trackSizes(rowWeights, H);
  const n = sessions.length;
  const shortLastRow = layout === "grid" ? n % gridCols : 0;

  let x = 0;
  for (let i = 0; i < gridCols - 1; i++) {
    x += cols[i] + (i > 0 ? GAP : 0);
    // The stretched last pane has no divider at this column boundary.
    const cut = shortLastRow > 0 && i + 1 >= shortLastRow ? rows[gridRows - 1] + GAP : 0;
    addSplitter("col", i, { left: `${x + GAP / 2 - 4}px`, top: "0", height: `${H - cut}px` });
  }
  let y = 0;
  for (let i = 0; i < gridRows - 1; i++) {
    y += rows[i] + (i > 0 ? GAP : 0);
    addSplitter("row", i, { top: `${y + GAP / 2 - 4}px`, left: "0", width: `${W}px` });
  }
}

function addSplitter(axis: "col" | "row", index: number, pos: Partial<CSSStyleDeclaration>) {
  const box = $("#terminals");
  const el = document.createElement("div");
  el.className = `splitter ${axis}`;
  el.title = "Drag to resize · double-click to reset";
  Object.assign(el.style, pos);
  box.appendChild(el);

  el.addEventListener("dblclick", () => {
    if (axis === "col") colWeights = Array(gridCols).fill(1);
    else rowWeights = Array(gridRows).fill(1);
    applyLayout();
  });

  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const weights = axis === "col" ? colWeights : rowWeights;
    const start = weights.slice();
    const total = axis === "col" ? box.clientWidth : box.clientHeight;
    const sum = start.reduce((a, b) => a + b, 0);
    const pxPerFr = (total - (start.length - 1) * GAP) / sum;
    const min = MIN_PANE_PX / pxPerFr;
    const origin = axis === "col" ? e.clientX : e.clientY;
    resizingPanes = true;
    document.body.classList.add(axis === "col" ? "resizing-col" : "resizing-row");
    el.classList.add("dragging");

    const move = (ev: PointerEvent) => {
      let d = ((axis === "col" ? ev.clientX : ev.clientY) - origin) / pxPerFr;
      d = Math.max(min - start[index], Math.min(start[index + 1] - min, d));
      weights[index] = start[index] + d;
      weights[index + 1] = start[index + 1] - d;
      box.style[axis === "col" ? "gridTemplateColumns" : "gridTemplateRows"] = template(weights);
      const delta = (weights[index] - start[index]) * pxPerFr;
      el.style.transform = axis === "col" ? `translateX(${delta}px)` : `translateY(${delta}px)`;
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      resizingPanes = false;
      document.body.classList.remove("resizing-col", "resizing-row");
      renderSplitters();
      sessions.forEach((x) => x.refit());
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end, { once: true });
    el.addEventListener("pointercancel", end, { once: true });
  });
}

new ResizeObserver(() => !resizingPanes && renderSplitters()).observe($("#terminals"));

// ---------- activation & header ----------

function activate(s: Session, focus = true) {
  const prev = active;
  active = s;
  if (zoomed && zoomed !== s) {
    zoomed = s;
    applyLayout();
  }
  for (const x of sessions) {
    x.el.classList.toggle("active", x === s);
    x.tab.classList.toggle("active", x === s);
  }
  if (windowFocused) s.clearAttention();
  $("#empty").hidden = true;
  saveWorkspace();
  if (prev !== s && !$("#searchbar").hidden) moveSearchTo(s, prev);
  updateTopbar();
  if (!focus) return;
  requestAnimationFrame(() => {
    s.refit();
    s.term.focus();
  });
}

const PERM_LABELS: Record<string, string> = {
  acceptEdits: "Accept edits",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
};

function chipsFor(o: LaunchOptions): HTMLSpanElement[] {
  const chips: [string, boolean, string?][] = [];
  if (o.model) chips.push([o.model[0].toUpperCase() + o.model.slice(1), false]);
  if (o.permissionMode) chips.push([PERM_LABELS[o.permissionMode] ?? o.permissionMode, o.permissionMode === "bypassPermissions"]);
  if (o.conversation === "continue") chips.push(["Continued", false]);
  if (o.conversation === "resume") chips.push(["Resumed", false, o.resumeTitle]);
  return chips.map(([label, warn, title]) => {
    const c = document.createElement("span");
    c.className = warn ? "chip warn" : "chip";
    c.textContent = label;
    if (title) c.title = title;
    return c;
  });
}

function updateTopbar() {
  $("#topbar").hidden = !active;
  sessions.forEach((x, i) => {
    x.tab.querySelector("kbd")!.textContent = i < 9 ? (isMac ? `⌘${i + 1}` : `${i + 1}`) : "";
  });
  $("#tab-count").textContent = sessions.length ? String(sessions.length) : "";
  if (!active) return;
  const o = active.opts;
  $("#tb-name").textContent = basename(o.cwd);
  $("#tb-path").textContent = o.cwd;
  const br = $("#tb-branch");
  br.hidden = !active.branch;
  br.innerHTML = active.branch ? `${icon("branch")}<span></span>` : "";
  if (active.branch) br.querySelector("span")!.textContent = active.branch;
  $("#tb-chips").replaceChildren(...chipsFor(o));
  $("#tb-split-label").textContent = zoomed
    ? `${basename(zoomed.opts.cwd)} maximised · ${sessions.length} sessions`
    : `${sessions.length} sessions · ${LAYOUT_NAMES[layout]}`;
}

function closeSession(s: Session) {
  if (s.running && !confirm(`End the Claude session in ${basename(s.opts.cwd)}?`)) return;
  const i = sessions.indexOf(s);
  sessions.splice(i, 1);
  if (zoomed === s) zoomed = null;
  if (!$("#searchbar").hidden && active === s) closeSearch();
  s.dispose();
  applyLayout();
  if (active === s) {
    const next = sessions[Math.min(i, sessions.length - 1)];
    if (next) activate(next);
    else {
      active = null;
      showEmpty();
    }
  }
  updateAttentionBadge();
  updateTopbar();
  saveWorkspace();
}

function startSession(opts: LaunchOptions) {
  pushRecent(opts.cwd);
  const s = new Session(opts);
  sessions.push(s);
  applyLayout();
  activate(s);
  void refreshBranch(s);
  // Wait a frame so the terminal has its real size before spawning.
  requestAnimationFrame(() => void assignConversation(s.opts).then(() => s.start()));
}

// ---------- workspace (reopened on launch) ----------

interface Workspace {
  sessions: LaunchOptions[];
  active: number;
}

let restoring = false;

function saveWorkspace() {
  if (restoring) return;
  store.set("workspace", {
    sessions: sessions.map((s) => s.opts),
    active: active ? sessions.indexOf(active) : 0,
  } satisfies Workspace);
}

/** Reopens the sessions that were open last time, each continuing its own conversation. */
function restoreWorkspace() {
  const ws = store.get<Workspace>("workspace", { sessions: [], active: 0 });
  if (!settings.restore || !Array.isArray(ws.sessions) || !ws.sessions.length) return;
  restoring = true;
  for (const opts of ws.sessions) {
    if (opts && typeof opts.cwd === "string") startSession(opts);
  }
  restoring = false;
  const target = sessions[ws.active] ?? sessions[0];
  if (target) activate(target);
  saveWorkspace();
}

// ---------- git branch ----------

async function refreshBranch(s: Session) {
  const b = await invoke<string | null>("git_branch", { cwd: s.opts.cwd }).catch(() => null);
  s.setBranch(b);
}
setInterval(() => sessions.forEach((s) => void refreshBranch(s)), 4000);

// ---------- search ----------

const searchInput = $<HTMLInputElement>("#search-input");

function openSearch() {
  if (!active) return;
  const bar = $("#searchbar");
  active.el.appendChild(bar);
  bar.hidden = false;
  const sel = active.term.getSelection();
  if (sel && !sel.includes("\n")) searchInput.value = sel;
  searchInput.select();
  searchInput.focus();
  if (searchInput.value) runSearch(true, true);
}

function closeSearch() {
  $("#searchbar").hidden = true;
  $("#search-count").textContent = "";
  active?.search.clearDecorations();
  active?.term.clearSelection();
  active?.term.focus();
}

function moveSearchTo(s: Session, prev: Session | null) {
  prev?.search.clearDecorations();
  s.el.appendChild($("#searchbar"));
  runSearch(true, true);
}

function runSearch(forward: boolean, incremental = false) {
  if (!active) return;
  const q = searchInput.value;
  if (!q) {
    active.search.clearDecorations();
    $("#search-count").textContent = "";
    return;
  }
  const opts = { decorations: SEARCH_DECORATIONS[resolvedTheme()], incremental };
  if (forward) active.search.findNext(q, opts);
  else active.search.findPrevious(q, opts);
}

searchInput.addEventListener("input", () => runSearch(true, true));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runSearch(!e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  }
});
$("#search-next").addEventListener("click", () => runSearch(true));
$("#search-prev").addEventListener("click", () => runSearch(false));
$("#search-close").addEventListener("click", closeSearch);
$("#tb-search").addEventListener("click", openSearch);

// ---------- empty state ----------

function showEmpty() {
  $("#empty").hidden = false;
  const list = $("#recent");
  list.innerHTML = "";
  const recent = recentFolders();
  $("#recent-wrap").hidden = recent.length === 0;
  for (const dir of recent) {
    const li = document.createElement("li");
    li.innerHTML = `${icon("folder")}<span class="meta"><span class="name"></span><span class="path"></span></span>`;
    li.querySelector(".name")!.textContent = basename(dir);
    li.querySelector(".path")!.textContent = dir;
    li.addEventListener("click", () => startSession({ ...lastLaunch, cwd: dir }));
    list.appendChild(li);
  }
}

// ---------- new-session dialog ----------

async function pickFolder(): Promise<string | null> {
  const dir = await openDialog({ directory: true, multiple: false, title: "Choose a project folder" });
  return typeof dir === "string" ? dir : null;
}

function setSegment(sel: string, value: string) {
  for (const b of $(sel).querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("on", b.dataset.v === value);
  }
}
function getSegment(sel: string): string {
  return $(sel).querySelector<HTMLButtonElement>("button.on")?.dataset.v ?? "";
}
for (const sel of ["#f-model", "#f-perm", "#f-conv", "#s-theme", "#s-line", "#s-termfont"]) {
  $(sel).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    setSegment(sel, b.dataset.v ?? "");
    if (sel === "#f-conv") void refreshConversations();
  });
}

const cwdInput = $<HTMLInputElement>("#f-cwd");
let conversations: Conversation[] = [];
let conversationsFor = "";
let selectedConversation: string | null = null;
let convRequest = 0;

/** Loads past conversations for the folder in the dialog and updates the picker. */
async function refreshConversations() {
  const mode = getSegment("#f-conv") as ConversationMode;
  const list = $("#f-resume-list");
  const hint = $("#f-conv-hint");
  const cwd = cwdInput.value.trim();
  list.hidden = mode !== "resume";
  hint.textContent = "";
  if (mode === "new" || !cwd) return;

  if (conversationsFor !== cwd) {
    const req = ++convRequest;
    hint.textContent = "Loading conversations…";
    const result = await invoke<Conversation[]>("list_conversations", { cwd }).catch(() => []);
    if (req !== convRequest) return; // a newer request superseded this one
    conversations = result;
    conversationsFor = cwd;
    selectedConversation = null;
    hint.textContent = "";
  }

  if (mode === "continue") {
    hint.textContent = conversations[0]
      ? `Continues “${conversations[0].title}” (${timeAgo(conversations[0].modifiedMs)})`
      : "No earlier conversation in this folder; Claude will start a new one.";
    return;
  }

  list.innerHTML = "";
  if (!conversations.length) {
    hint.textContent = "No earlier conversations in this folder.";
    return;
  }
  for (const c of conversations) {
    const li = document.createElement("li");
    li.tabIndex = 0;
    li.innerHTML = `${icon("history")}<span class="meta"><span class="name"></span><span class="sub"></span></span>`;
    li.querySelector(".name")!.textContent = c.title;
    li.querySelector(".sub")!.textContent =
      `${timeAgo(c.modifiedMs)} · ${c.prompts} prompt${c.prompts === 1 ? "" : "s"}`;
    li.classList.toggle("on", c.id === selectedConversation);
    const pick = () => {
      selectedConversation = c.id;
      list.querySelectorAll("li").forEach((x) => x.classList.toggle("on", x === li));
    };
    li.addEventListener("click", pick);
    li.addEventListener("dblclick", () => {
      pick();
      $<HTMLFormElement>("#new-form").requestSubmit($("#new-form button.primary"));
    });
    li.addEventListener("keydown", (e) => e.key === " " && (e.preventDefault(), pick()));
    list.appendChild(li);
  }
}

let cwdTimer = 0;
cwdInput.addEventListener("input", () => {
  clearTimeout(cwdTimer);
  cwdTimer = window.setTimeout(() => void refreshConversations(), 300);
});

function openNewDialog(prefill?: string) {
  const dlg = $<HTMLDialogElement>("#new-dialog");
  cwdInput.value = prefill ?? recentFolders()[0] ?? "";
  setSegment("#f-model", lastLaunch.model);
  setSegment("#f-perm", lastLaunch.permissionMode);
  setSegment("#f-conv", lastLaunch.conversation);
  $<HTMLInputElement>("#f-extra").value = lastLaunch.extra;
  conversationsFor = "";
  void refreshConversations();

  const chips = $("#f-recent");
  chips.innerHTML = "";
  for (const dir of recentFolders()) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = basename(dir);
    b.title = dir;
    b.addEventListener("click", () => {
      cwdInput.value = dir;
      void refreshConversations();
    });
    chips.appendChild(b);
  }
  dlg.returnValue = "";
  dlg.showModal();
  cwdInput.select();
}

$("#f-browse").addEventListener("click", async () => {
  const dir = await pickFolder();
  if (dir) {
    cwdInput.value = dir;
    void refreshConversations();
  }
});

$("#new-form").addEventListener("submit", (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  if (getSegment("#f-conv") === "resume" && !selectedConversation) {
    e.preventDefault();
    $("#f-conv-hint").textContent = conversations.length
      ? "Pick a conversation to resume."
      : "No earlier conversations in this folder.";
  }
});

$<HTMLDialogElement>("#new-dialog").addEventListener("close", () => {
  const dlg = $<HTMLDialogElement>("#new-dialog");
  if (dlg.returnValue !== "ok") return;
  const conversation = getSegment("#f-conv") as ConversationMode;
  lastLaunch = {
    model: getSegment("#f-model"),
    permissionMode: getSegment("#f-perm"),
    conversation: conversation === "resume" ? "new" : conversation,
    extra: $<HTMLInputElement>("#f-extra").value.trim(),
  };
  store.set("lastLaunch", lastLaunch);
  const resumed = conversations.find((c) => c.id === selectedConversation);
  startSession({
    ...lastLaunch,
    conversation,
    resumeId: conversation === "resume" ? resumed?.id : undefined,
    resumeTitle: conversation === "resume" ? resumed?.title : undefined,
    cwd: cwdInput.value.trim(),
  });
});

// ---------- settings ----------

function openSettings() {
  $<HTMLInputElement>("#s-binary").value = settings.binary;
  $<HTMLInputElement>("#s-font").value = String(settings.fontSize);
  $<HTMLInputElement>("#s-notify").checked = settings.notifications;
  $<HTMLInputElement>("#s-restore").checked = settings.restore;
  setSegment("#s-theme", settings.theme);
  setSegment("#s-line", String(settings.lineHeight));
  setSegment("#s-termfont", settings.font);
  const dlg = $<HTMLDialogElement>("#settings-dialog");
  dlg.returnValue = "";
  dlg.showModal();
}

$<HTMLDialogElement>("#settings-dialog").addEventListener("close", () => {
  if ($<HTMLDialogElement>("#settings-dialog").returnValue !== "ok") return;
  const font = Number($<HTMLInputElement>("#s-font").value);
  settings = {
    binary: $<HTMLInputElement>("#s-binary").value.trim(),
    font: (getSegment("#s-termfont") || "Cascadia Mono") as TerminalFont,
    fontSize: Number.isFinite(font) && font >= 8 && font <= 32 ? Math.round(font * 2) / 2 : 12,
    lineHeight: Number(getSegment("#s-line")) || 1,
    theme: (getSegment("#s-theme") || "dark") as ThemePref,
    notifications: $<HTMLInputElement>("#s-notify").checked,
    restore: $<HTMLInputElement>("#s-restore").checked,
    v: 4,
  };
  store.set("settings", settings);
  applyTheme();
  // Load the font before handing it to xterm so it measures the real glyphs.
  void Promise.all(["400", "600"].map((w) => document.fonts.load(`${w} ${fontPx()}px "${settings.font}"`)))
    .catch(() => {})
    .then(() => {
      for (const s of sessions) {
        s.term.options.fontFamily = fontStack(settings.font);
        s.term.options.fontSize = fontPx();
        s.term.options.lineHeight = settings.lineHeight;
        s.refit();
      }
    });
  void checkCli();
});

// ---------- updates ----------
//
// Like Fleet: every push to main publishes a signed release, and the latest
// release carries latest.json (see .github/workflows/release.yml). The app
// reads it shortly after starting; if it names a newer version a toast offers
// to install it. The download is checked against the public key in
// tauri.conf.json before it is installed, then the app restarts on it.

let pendingUpdate: Update | null = null;
let updateDismissed = "";

async function lookForUpdate(manual = false): Promise<void> {
  const status = $("#s-version");
  if (manual) status.textContent = "Checking…";
  let update: Update | null = null;
  try {
    update = await check();
  } catch (err) {
    // Offline, or no release yet: the next check tries again.
    if (manual) status.textContent = `Couldn't check for updates: ${err}`;
    return;
  }
  if (!update) {
    if (manual) status.textContent = `Claude Desk ${await getVersion()} is up to date.`;
    return;
  }
  pendingUpdate = update;
  if (manual) status.textContent = `Claude Desk ${update.version} is available.`;
  if (manual || updateDismissed !== update.version) showUpdateToast(update);
}

function showUpdateToast(update: Update) {
  const toastEl = $("#update-toast");
  toastEl.querySelector(".ut-text")!.textContent =
    `Claude Desk ${update.version} is out (you have ${update.currentVersion})`;
  const go = toastEl.querySelector<HTMLButtonElement>(".ut-go")!;
  go.disabled = false;
  go.textContent = "Install and restart";
  toastEl.hidden = false;
}

async function installUpdate() {
  const update = pendingUpdate;
  if (!update) return;
  const running = sessions.filter((s) => s.running).length;
  if (
    running &&
    !confirm(
      settings.restore
        ? `Install the update now? Your ${running} session${running === 1 ? "" : "s"} will reopen after the restart and continue where they left off.`
        : `Restarting ends ${running} running Claude session${running === 1 ? "" : "s"}. Install the update now?`,
    )
  ) {
    return;
  }
  const go = $("#update-toast").querySelector<HTMLButtonElement>(".ut-go")!;
  go.disabled = true;
  let total = 0;
  let done = 0;
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        go.textContent = total ? `Downloading… ${Math.round((done / total) * 100)}%` : "Downloading…";
      } else if (ev.event === "Finished") go.textContent = "Installing…";
    });
    go.textContent = "Restarting…";
    // Sessions end with the old window; the new one starts fresh.
    for (const s of sessions) s.dispose();
    await relaunch();
  } catch (err) {
    go.disabled = false;
    go.textContent = "Try again";
    $("#update-toast").querySelector(".ut-text")!.textContent = `Update failed: ${err}`;
  }
}

$("#update-toast").querySelector(".ut-go")!.addEventListener("click", () => void installUpdate());
$("#update-toast").querySelector(".ut-later")!.addEventListener("click", () => {
  updateDismissed = pendingUpdate?.version ?? "";
  $("#update-toast").hidden = true;
});
$("#s-check").addEventListener("click", () => void lookForUpdate(true));
void getVersion().then((v) => ($("#s-version").textContent = `Claude Desk ${v}`)).catch(() => {});

// Check 10 s after opening (as Fleet does), then every 6 hours for windows left open.
setTimeout(() => void lookForUpdate(), 10_000);
setInterval(() => void lookForUpdate(), 6 * 60 * 60 * 1000);

// ---------- CLI status ----------

async function checkCli() {
  const el = $("#cli-status");
  el.className = "cli-status";
  el.textContent = "Checking CLI…";
  try {
    const v = await invoke<string>("claude_version", { binary: settings.binary || null });
    el.textContent = `Claude Code ${v.split(/\s+/)[0]}`;
    el.classList.add("ok");
    el.title = v;
  } catch (err) {
    el.textContent = "CLI not found";
    el.classList.add("bad");
    el.title = `${err}\n\nInstall Claude Code or set its path in Settings.`;
  }
}

// ---------- shortcuts ----------

function isAppShortcut(e: KeyboardEvent): boolean {
  const mod = isMac ? e.metaKey : e.ctrlKey && e.shiftKey;
  if (mod && ["KeyT", "KeyW", "Comma", "Backslash", "KeyF", "Enter", "KeyB"].includes(e.code)) return true;
  if (e.ctrlKey && e.key === "Tab") return true;
  if (mod && /^Digit[1-9]$/.test(e.code)) return true;
  return false;
}

window.addEventListener("keydown", (e) => {
  if (!isAppShortcut(e) || document.querySelector("dialog[open]")) return;
  e.preventDefault();
  if (e.code === "KeyT") openNewDialog();
  else if (e.code === "KeyW" && active) closeSession(active);
  else if (e.code === "Comma") openSettings();
  else if (e.code === "KeyF") openSearch();
  else if (e.code === "KeyB") toggleSidebar();
  else if (e.code === "Enter" && active) toggleZoom(active);
  else if (e.code === "Backslash") setLayout(LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length]);
  else if (e.key === "Tab" && active && sessions.length > 1) {
    const i = sessions.indexOf(active);
    activate(sessions[(i + (e.shiftKey ? -1 : 1) + sessions.length) % sessions.length]);
  } else if (e.code.startsWith("Digit")) {
    const s = sessions[Number(e.code.slice(5)) - 1];
    if (s) activate(s);
  }
});

// ---------- drag & drop ----------

void getCurrentWebview().onDragDropEvent((ev) => {
  const p = ev.payload;
  document.body.classList.toggle("dragging", p.type === "enter" || p.type === "over");
  if (p.type !== "drop" || p.paths.length === 0) return;
  if (active?.running) {
    // Dropping files into a session inserts their paths, like a terminal does.
    active.write(p.paths.map(shellQuote).join(" ") + " ");
    active.term.focus();
  } else {
    openNewDialog(p.paths[0]);
  }
});

// ---------- boot ----------

void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  windowFocused = focused;
  if (focused && active) active.clearAttention();
});

$("#new-btn").addEventListener("click", () => openNewDialog());
$("#empty-open").addEventListener("click", async () => {
  const dir = await pickFolder();
  if (dir) startSession({ ...lastLaunch, cwd: dir });
});
$("#settings-btn").addEventListener("click", openSettings);
$("#new-kbd").textContent = isMac ? "⌘T" : "Ctrl⇧T";
$("#empty-new").addEventListener("click", () => openNewDialog());
$("#tb-restart").addEventListener("click", () => active?.restart());
$("#tb-close").addEventListener("click", () => active && closeSession(active));
$("#tb-search").title = `Search terminal (${isMac ? "⌘F" : "Ctrl+Shift+F"})`;
if (isMac) document.body.classList.add("mac");

// Load the bundled fonts up front so xterm measures the real glyphs.
const fontsReady = Promise.all(
  ["400", "600"].map((w) => document.fonts.load(`${w} ${fontPx()}px "${settings.font}"`)),
).catch(() => {});

for (const b of document.querySelectorAll<HTMLButtonElement>("#layout-switch button")) {
  b.addEventListener("click", () => setLayout(b.dataset.layout as Layout));
  b.title += ` (${isMac ? "⌘\\" : "Ctrl+Shift+\\"} to cycle)`;
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("dialog .cancel")) {
  btn.addEventListener("click", () => btn.closest("dialog")!.close("cancel"));
}

// ---------- collapsible sidebar ----------

let sidebarCollapsed = store.get("ui", { sidebarCollapsed: false }).sidebarCollapsed === true;

function applySidebar() {
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  const key = isMac ? "⌘B" : "Ctrl+Shift+B";
  $("#sidebar-toggle").title = `${sidebarCollapsed ? "Expand" : "Collapse"} sidebar (${key})`;
  $("#new-btn").title = sidebarCollapsed ? `New session (${isMac ? "⌘T" : "Ctrl+Shift+T"})` : "";
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  store.set("ui", { sidebarCollapsed });
  applySidebar();
}

$("#sidebar-toggle").addEventListener("click", toggleSidebar);
applySidebar();

applyTheme();
showEmpty();
applyLayout();
// Restored terminals must measure the real font, so wait for it first.
void fontsReady.then(restoreWorkspace);
void checkCli();
