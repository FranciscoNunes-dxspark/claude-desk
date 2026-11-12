import "@xterm/xterm/css/xterm.css";
import "@fontsource-variable/inter";
import "./style.css";
import { BUNDLED_FONTS, CUSTOM_FONT, DEFAULT_FONT, boldWeight, fontAvailable, fontStack } from "./fonts";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { getVersion } from "@tauri-apps/api/app";

import { SEARCH_DECORATIONS, TERMINAL_THEMES, type ThemeName } from "./themes";

// ---------- persisted settings ----------

type ThemePref = "system" | ThemeName;
type ConversationMode = "new" | "continue" | "resume";


interface Settings {
  binary: string;
  /** A bundled font's name, or CUSTOM_FONT to use `customFont`. */
  font: string;
  /** Name of a font installed on this computer (when `font` is CUSTOM_FONT). */
  customFont: string;
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
  /** Display name chosen by the user (also passed to Claude Code as --name). */
  name?: string;
  /** Colour tag (a SESSION_COLORS key). */
  color?: string;
  /** Run in a git worktree of this name (Claude Code's --worktree). */
  worktree?: string;
  /** Where the session actually runs: the worktree's folder, once known. */
  workdir?: string;
}

/** The folder a session runs in: its worktree if it has one, else the chosen folder. */
const dirOf = (o: LaunchOptions) => o.workdir ?? o.cwd;

/** How a session is labelled: its custom name, else the folder (and worktree). */
const displayName = (o: LaunchOptions) =>
  o.name?.trim() || (o.worktree ? `${basename(o.cwd)} · ${o.worktree}` : basename(o.cwd));

const SESSION_COLORS: Record<string, string> = {
  red: "#e5736a",
  orange: "#e0975a",
  yellow: "#e0b86b",
  green: "#8fbf7f",
  teal: "#70c0b1",
  blue: "#7aa6da",
  purple: "#c397d8",
  pink: "#e58fb5",
};

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
  customFont: "",
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
if (settings.font !== CUSTOM_FONT && !BUNDLED_FONTS.some((f) => f.name === settings.font)) settings.font = DEFAULT_FONT;
if (typeof settings.customFont !== "string") settings.customFont = "";

/** The terminal's font family: the chosen bundled font, or the custom installed one. */
const termFont = () =>
  settings.font === CUSTOM_FONT ? settings.customFont.trim() || DEFAULT_FONT : settings.font;

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
function buildArgs(o: LaunchOptions, conversationSaved: boolean, createWorktree = false): string[] {
  const args: string[] = [];
  if (createWorktree && o.worktree) args.push("--worktree", o.worktree);
  if (o.name?.trim()) args.push("--name", o.name.trim());
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
    const list = await invoke<Conversation[]>("list_conversations", { cwd: dirOf(o) }).catch(() => []);
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

/**
 * Asks before something destructive. (The web view's `confirm()` is replaced by the
 * dialog plugin with an async version, so it can't be used as a yes/no answer.)
 * If the dialog can't be shown, goes ahead rather than leaving the action stuck.
 */
async function askToConfirm(message: string, okLabel: string): Promise<boolean> {
  try {
    return await ask(message, { title: "Switchyard", kind: "warning", okLabel, cancelLabel: "Cancel" });
  } catch {
    return true;
  }
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

type ProgramState = "working" | "blocked" | "idle" | "done";
interface ProgramEntry {
  state: ProgramState;
  kind?: string;
  title?: string;
  msg?: string;
}
interface WorktreeInfo {
  root: string;
  path: string;
  exists: boolean;
}

function decodeB64(v?: string): string | undefined {
  if (!v) return undefined;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

function stateLabel(state: ProgramState | null, kind?: string): string {
  switch (state) {
    case "working":
      return "Working…";
    case "blocked":
      return kind === "permission" ? "Needs permission" : kind === "question" ? "Has a question" : "Needs you";
    case "done":
      return "Done";
    case "idle":
      return "Ready";
    default:
      return "";
  }
}

/**
 * Wraps code that xterm runs while parsing output (escape-sequence handlers, the bell).
 * An exception there stops xterm processing that terminal's output for good: nothing
 * more is drawn or acknowledged, the backend stops reading, and Claude blocks on its
 * output, so the session freezes. Errors are logged instead.
 */
function guarded<A extends unknown[]>(fn: (...args: A) => boolean | void): (...args: A) => boolean {
  return (...args) => {
    try {
      return fn(...args) ?? true;
    } catch (err) {
      console.error("terminal handler failed:", err);
      return true;
    }
  };
}

class Session {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly search = new SearchAddon();
  readonly tab: HTMLLIElement;
  attention = false;
  branch: string | null = null;
  /** Token usage of this session's conversation (see `conversation_usage`). */
  usage: Usage | null = null;
  /** Claude Code's own live status (its status line input, see `pty_status`). */
  status: ClaudeStatus | null = null;
  /** Claude Code's own status reports (OSC 7501), per id ("" is the main thread). */
  private program = new Map<string, ProgramEntry>();
  /** Set once Claude Code has reported status; the output heuristic is then off. */
  statusSupported = false;
  state: ProgramState | null = null;
  private ptyId: number | null = null;
  private restartPending = false;
  private disposed = false;
  /** Numbers each start; output, exit and acks from an earlier run are ignored. */
  private run = 0;
  /** Set while a start is in progress, so Enter or Restart can't start a second Claude. */
  private starting = false;
  /** Keys typed while Claude is starting, sent once its process exists. */
  private pendingInput: string[] = [];
  private banner: HTMLDivElement | null = null;
  private resizeObs: ResizeObserver;
  private burstStart = 0;
  private lastOutput = 0;
  private burstAlerted = true;

  constructor(readonly opts: LaunchOptions) {
    this.el = document.createElement("div");
    this.el.className = "term";
    this.el.innerHTML = `
      <div class="pane-head">
        <span class="dot"></span>
        <span class="pane-name"></span>
        <span class="pane-path"></span>
        <span class="branch" hidden></span>
        <span class="state-label" hidden></span>
        <span class="usage" hidden></span>
        <span class="chips-row"></span>
        <button class="icon-btn" data-act="zoom" title="Maximise">${icon("max")}</button>
        <button class="icon-btn" data-act="restart" title="Restart session">${icon("restart")}</button>
        <button class="icon-btn" data-act="close" title="Close session">${icon("x")}</button>
      </div>
      <div class="term-body"><div class="term-host"></div></div>`;
    this.el.querySelector(".pane-path")!.textContent = dirOf(opts);
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
      fontFamily: fontStack(termFont()),
      fontSize: fontPx(),
      fontWeight: "400",
      fontWeightBold: boldWeight(termFont()),
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

    this.term.attachCustomKeyEventHandler((e) => {
      try {
        return this.handleKey(e);
      } catch (err) {
        console.error("key handler failed:", err);
        return true; // let xterm send the key to Claude as usual
      }
    });
    this.term.onData((data) => this.write(data));
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId != null) void invoke("pty_resize", { id: this.ptyId, cols, rows }).catch(() => {});
    });
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(this.body);

    // Claude Code's program status (OSC 7501): it asks "7501;?" at startup and, if the
    // terminal answers, reports state=working|blocked|idle|done|clear with a title,
    // message and, when blocked, a kind (permission, question).
    this.term.parser.registerOscHandler(7501, guarded((data) => {
      if (data.startsWith("?")) {
        this.write("\x1b]7501;?\x07");
        return true;
      }
      this.onProgramStatus(data);
      return true;
    }));

    // Explicit "look at me" signals: terminal bell and OSC 9 / OSC 777 notifications.
    this.term.onBell(guarded(() => this.flagAttention("needs your attention")));
    this.term.parser.registerOscHandler(9, guarded((data) => {
      // OSC 9;4 is a progress report, not a notification.
      if (!/^4;/.test(data)) this.flagAttention("needs your attention", data);
      return true;
    }));
    this.term.parser.registerOscHandler(777, guarded((data) => {
      const [kind, title, body] = data.split(";");
      if (kind === "notify") this.flagAttention(title || "needs your attention", body);
      return true;
    }));

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
      <span class="meta"><span class="name"></span><span class="path"></span><span class="status-line" hidden></span></span>
      <kbd></kbd>
      <button class="icon-btn close" title="Close session">${icon("x")}</button>
      <span class="ctx-line" hidden><i></i></span>`;
    this.tab.querySelector(".path")!.textContent = `\u200E${dirOf(opts)}\u200E`;
    this.tab.addEventListener("click", () => {
      if (!tabDrag.suppressClick) activate(this);
    });
    this.tab.addEventListener("dblclick", (e) => {
      if (!(e.target as HTMLElement).closest("button")) openSessionDialog(this);
    });
    this.tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openSessionDialog(this);
    });
    this.tab.addEventListener("pointerdown", (e) => startTabDrag(e, this));
    this.tab.querySelector(".close")!.addEventListener("click", (e) => {
      e.stopPropagation();
      closeSession(this);
    });
    $("#tabs").appendChild(this.tab);
    this.applyIdentity();
  }

  /** Shows the session's name, colour and folder everywhere it appears. */
  applyIdentity() {
    const name = displayName(this.opts);
    this.el.querySelector(".pane-name")!.textContent = name;
    this.tab.querySelector(".name")!.textContent = name;
    this.tab.querySelector(".initial")!.textContent = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "•").toUpperCase();
    this.tab.title = `${name} — ${dirOf(this.opts)}\nDouble-click or right-click to rename · drag to reorder`;
    const color = this.opts.color ? SESSION_COLORS[this.opts.color] : undefined;
    for (const el of [this.tab, this.el]) {
      if (color) el.style.setProperty("--session-color", color);
      else el.style.removeProperty("--session-color");
      el.classList.toggle("colored", !!color);
    }
    if (this === active) updateTopbar();
  }

  /** Handles one OSC 7501 report from Claude Code. */
  private onProgramStatus(data: string) {
    const f: Record<string, string> = {};
    for (const part of data.split(":")) {
      const i = part.indexOf("=");
      if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
    }
    const id = f.id ?? "";
    if (f.state === "clear") {
      if (f.id === undefined) this.program.clear();
      else this.program.delete(id);
    } else if (f.state) {
      this.program.set(id, {
        state: f.state as ProgramState,
        kind: f.kind,
        title: decodeB64(f.title),
        msg: decodeB64(f.msg),
      });
    } else return;
    this.statusSupported = true;
    this.updateProgramStatus();
  }

  private updateProgramStatus() {
    const entries = [...this.program.values()];
    const main = this.program.get("");
    const blocked = entries.find((e) => e.state === "blocked");
    const next: ProgramState | null = blocked
      ? "blocked"
      : entries.some((e) => e.state === "working")
        ? "working"
        : main?.state === "done"
          ? "done"
          : entries.length
            ? "idle"
            : null;
    const prev = this.state;
    this.state = next;
    const shown = blocked ?? main ?? entries[0];
    const label = stateLabel(next, blocked?.kind);
    for (const el of [this.tab, this.el]) {
      if (next) el.dataset.state = next;
      else delete el.dataset.state;
    }
    const line = this.tab.querySelector<HTMLElement>(".status-line")!;
    const path = this.tab.querySelector<HTMLElement>(".path")!;
    const detail = shown?.title && next !== "blocked" ? ` · ${shown.title}` : "";
    line.textContent = label ? `${label}${detail}` : "";
    line.hidden = !label;
    path.hidden = !!label;
    const chip = this.el.querySelector<HTMLElement>(".state-label")!;
    chip.textContent = label;
    chip.hidden = !label;
    if (this === active) updateTopbar();

    // Tell the user when Claude needs them, or has finished something.
    if (next === "blocked" && prev !== "blocked") {
      const what = blocked?.kind === "permission" ? "needs your permission" : blocked?.kind === "question" ? "has a question" : "needs you";
      this.flagAttention(what, blocked?.msg || blocked?.title);
    } else if (prev === "working" && (next === "idle" || next === "done")) {
      this.flagAttention("finished", shown?.title);
    }
    if (prev !== next && changesOpen() && this === active) scheduleChangesRefresh(300);
    if (prev !== next) void this.refreshStatus().then(() => this.refreshUsage());
  }

  get running() {
    return this.ptyId != null;
  }

  /** Reads Claude Code's live status: follows /clear and /resume to the conversation
   *  it switched to, and picks up the context window and the plan's limits. */
  async refreshStatus() {
    if (this.ptyId == null) return;
    const st = await invoke<ClaudeStatus | null>("pty_status", { id: this.ptyId }).catch(() => null);
    if (!st || JSON.stringify(st) === JSON.stringify(this.status)) return;
    this.status = st;
    if (st.rate_limits) noteLimits(st.rate_limits);
    const sid = st.session_id;
    if (sid && /^[\w-]+$/.test(sid) && sid !== this.opts.conversationId) {
      // Restarts and restored workspaces now reopen the conversation Claude is on.
      this.opts.conversationId = sid;
      this.usage = null;
      saveWorkspace();
    }
    this.showUsage();
  }

  /** Reads the conversation's token usage and shows it if it changed. */
  async refreshUsage() {
    const id = this.opts.conversationId;
    if (!id) return;
    const u = await invoke<Usage | null>("conversation_usage", { cwd: dirOf(this.opts), id }).catch(() => null);
    if (id !== this.opts.conversationId || JSON.stringify(u) === JSON.stringify(this.usage)) return;
    this.usage = u;
    this.showUsage();
  }

  private showUsage() {
    renderUsage(this.el.querySelector<HTMLElement>(".usage")!, this);
    const ctx = contextOf(this);
    const line = this.tab.querySelector<HTMLElement>(".ctx-line")!;
    line.hidden = !ctx;
    if (ctx) {
      line.dataset.level = ctx.level;
      line.querySelector("i")!.style.width = `${ctx.pct}%`;
    }
    if (this === active) updateTopbar();
  }

  blockedKind(): string | undefined {
    return [...this.program.values()].find((e) => e.state === "blocked")?.kind;
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
      if (this.starting) this.pendingInput.push(data);
      // Enter restarts an exited session.
      else if (data === "\r" && this.banner) void this.start();
      return;
    }
    const id = this.ptyId;
    const run = this.run;
    void invoke("pty_write", { id, data }).catch(() => {
      // The backend no longer has this process. Its exit notice normally follows
      // within a second; if it never does, show the session as ended rather than
      // leaving a terminal that silently ignores what's typed.
      setTimeout(() => {
        if (this.run === run && this.ptyId === id) this.exited(null);
      }, 1500);
    });
  }

  /** Types `text` into Claude's prompt and submits it (used by broadcast). */
  sendPrompt(text: string) {
    if (this.ptyId == null) return;
    // Paste through xterm: it uses bracketed paste only when the program turned it on
    // (Claude Code does), keeping multi-line text as one prompt. Submit once it landed.
    this.term.paste(text);
    setTimeout(() => this.write("\r"), 150);
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
    if (this.statusSupported || this.burstAlerted || !this.running) return;
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
    if (!windowFocused) void desktopNotify(`${displayName(this.opts)}: Claude ${what}`, detail || dirOf(this.opts));
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
    if (this.starting || this.ptyId != null || this.disposed) return;
    this.starting = true;
    this.pendingInput = [];
    const run = ++this.run;
    try {
      await this.spawn(run);
    } finally {
      this.starting = false;
      this.pendingInput = [];
    }
  }

  private async spawn(run: number) {
    if (this.banner) {
      // Restarting: clear the previous run's screen so the new TUI draws cleanly.
      this.banner.remove();
      this.banner = null;
      this.term.reset();
    }
    this.refit();
    this.setStatus("running");

    // Flow control: acknowledge bytes once xterm has processed them. The backend
    // pauses reading when 1 MB is unacknowledged, so a flood of output can't pile up
    // in memory faster than it can be drawn. (It never waits more than 2 s, so a
    // missed ack can slow a session down but not freeze it.)
    const ACK_EVERY = 64 << 10;
    let owed = 0;
    let flushTimer = 0;
    const current = () => run === this.run && !this.disposed;
    const ack = (force: boolean) => {
      if (!current() || this.ptyId == null || owed === 0 || (!force && owed < ACK_EVERY)) return;
      void invoke("pty_ack", { id: this.ptyId, bytes: owed }).catch(() => {});
      owed = 0;
    };
    const onData = new Channel<ArrayBuffer | number[]>();
    onData.onmessage = (chunk) => {
      if (!current()) return; // a previous run's last output
      const bytes = new Uint8Array(chunk);
      this.noteOutput();
      // A hidden window's timers are throttled, which slows xterm's processing; ack
      // on arrival then, so Claude isn't held back while the app is minimised.
      const early = document.hidden;
      if (early) owed += bytes.length;
      this.term.write(bytes, () => {
        if (!early) owed += bytes.length;
        ack(false);
        // Settle the remainder once output pauses, so nothing stays owed.
        clearTimeout(flushTimer);
        flushTimer = window.setTimeout(() => ack(true), 250);
      });
      if (early) ack(false);
    };
    const onExit = new Channel<{ code: number | null }>();
    onExit.onmessage = ({ code }) => {
      clearTimeout(flushTimer);
      if (run === this.run) this.exited(code);
    };

    // A worktree session: the first start asks Claude Code to create it (--worktree),
    // later starts run in it directly.
    let createWorktree = false;
    let spawnDir = dirOf(this.opts);
    if (this.opts.worktree) {
      const wt = await invoke<WorktreeInfo | null>("worktree_info", { cwd: this.opts.cwd, name: this.opts.worktree }).catch(() => null);
      if (wt) {
        if (this.opts.workdir !== wt.path) {
          this.opts.workdir = wt.path;
          saveWorkspace();
          this.applyIdentity();
          this.tab.querySelector(".path")!.textContent = `\u200E${wt.path}\u200E`;
          this.el.querySelector(".pane-path")!.textContent = wt.path;
        }
        createWorktree = !wt.exists;
        spawnDir = wt.exists ? wt.path : this.opts.cwd;
      }
    }
    this.program.clear();
    this.statusSupported = false;
    this.status = null;
    this.updateProgramStatus();

    try {
      const id = await invoke<number>("pty_spawn", {
        cwd: spawnDir,
        args: buildArgs(
          this.opts,
          await invoke<boolean>("conversation_exists", { cwd: dirOf(this.opts), id: this.opts.conversationId }).catch(
            () => false,
          ),
          createWorktree,
        ),
        binary: settings.binary || null,
        cols: this.term.cols,
        rows: this.term.rows,
        onData,
        onExit,
      });
      if (!current()) {
        // Closed (or superseded) while Claude was starting: don't leave it running.
        void invoke("pty_kill", { id }).catch(() => {});
        return;
      }
      this.ptyId = id;
      if (this.pendingInput.length) this.write(this.pendingInput.splice(0).join(""));
      // The pane may have been resized while the process was starting (resize
      // events are dropped until we have an id), so sync the size once more.
      this.refit();
      void invoke("pty_resize", { id: this.ptyId, cols: this.term.cols, rows: this.term.rows }).catch(() => {});
    } catch (err) {
      if (!current()) return;
      this.term.write(`\r\n\x1b[31mCould not start Claude Code:\x1b[0m ${err}\r\n`);
      this.exited(null);
    }
  }

  restart() {
    if (this.starting) return;
    if (this.ptyId == null) return void this.start();
    this.restartPending = true;
    void invoke("pty_kill", { id: this.ptyId }).catch(() => {});
  }

  private exited(code: number | null) {
    this.ptyId = null;
    if (this.disposed) return; // closed on purpose: no banner, no "session ended" alert
    if (this.banner) return; // already shown as ended
    if (this.restartPending) {
      this.restartPending = false;
      this.term.reset();
      return void this.start();
    }
    this.program.clear();
    this.updateProgramStatus();
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
    this.disposed = true;
    if (this.ptyId != null) void invoke("pty_kill", { id: this.ptyId }).catch(() => {});
    // Off screen first, so the session is gone even if tearing the terminal down fails.
    this.el.remove();
    this.tab.remove();
    this.resizeObs.disconnect();
    try {
      this.term.dispose();
    } catch (err) {
      console.error("disposing terminal:", err);
    }
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
    x.el.querySelector<HTMLElement>(".pane-head")!.title = split ? "Double-click to maximise" : "";
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
  if (prev !== s && !searchBar.hidden) moveSearchTo(s, prev);
  if (prev !== s && changesOpen()) scheduleChangesRefresh();
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
  // With no session there's no top bar to drag the window by: a strip stands in.
  $("#drag-strip").hidden = !isWindows || !!active;
  sessions.forEach((x, i) => {
    x.tab.querySelector("kbd")!.textContent = i < 9 ? (isMac ? `⌘${i + 1}` : `${i + 1}`) : "";
  });
  $("#tab-count").textContent = sessions.length ? String(sessions.length) : "";
  // The session's own details and actions are on its pane's header row.
  const count = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  $("#tb-split-label").textContent = zoomed
    ? `${displayName(zoomed.opts)} maximised · ${count}`
    : `${count} · ${LAYOUT_NAMES[layout]}`;
}

/** Sessions waiting on "End the session?", so a second click doesn't ask twice. */
const closing = new Set<Session>();

async function closeSession(s: Session) {
  if (closing.has(s) || !sessions.includes(s)) return;
  if (s.running) {
    closing.add(s);
    const ok = await askToConfirm(`End the Claude session "${displayName(s.opts)}"?`, "End session");
    closing.delete(s);
    // Closed meanwhile (e.g. from its banner after it exited)?
    if (!ok || !sessions.includes(s)) return;
  }
  const i = sessions.indexOf(s);
  sessions.splice(i, 1);
  if (zoomed === s) zoomed = null;
  if (!searchBar.hidden && active === s) closeSearch();
  // The search bar moves into the pane it searches; take it back before the pane goes.
  if (s.el.contains(searchBar)) {
    searchBar.hidden = true;
    searchHome.appendChild(searchBar);
  }
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

// ---------- token usage ----------

interface Usage {
  /** Tokens in the latest main-thread request: what the context holds now. */
  context: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  requests: number;
  model: string | null;
}

/** Claude Code's status line input (the parts used here). */
interface ClaudeStatus {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  context_window?: {
    total_input_tokens?: number;
    context_window_size?: number;
    used_percentage?: number | null;
    current_usage?: unknown;
  };
  rate_limits?: RateLimits;
}
interface LimitWindow {
  used_percentage: number;
  resets_at: number;
}
interface RateLimits {
  five_hour?: LimitWindow;
  seven_day?: LimitWindow;
}

/** How full a session's context is: from Claude Code itself when it reports it, else
 *  estimated from the conversation file (older Claude Code, or a status line that's
 *  overridden by managed settings). */
function contextOf(s: Session): { tokens: number; window: number; pct: number; level: string } | null {
  const cw = s.status?.context_window;
  let tokens: number;
  let window: number;
  let pct: number;
  if (cw?.context_window_size) {
    if (cw.current_usage == null) return null; // nothing sent in this conversation yet
    tokens = cw.total_input_tokens ?? 0;
    window = cw.context_window_size;
    pct = cw.used_percentage ?? (tokens / window) * 100;
  } else if (s.usage) {
    tokens = s.usage.context;
    // The window isn't in the file: 1M if asked for with [1m] or already past 200K.
    const big = `${s.opts.model} ${s.opts.extra}`.toLowerCase().includes("[1m]") || tokens > 200_000;
    window = big ? 1_000_000 : 200_000;
    pct = (tokens / window) * 100;
  } else return null;
  pct = Math.max(0, Math.min(100, pct));
  return { tokens, window, pct, level: pct >= 90 ? "full" : pct >= 70 ? "high" : "ok" };
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

/** Fills a `.usage` element: a small context gauge, the tokens in context, and the details on hover. */
function renderUsage(el: HTMLElement, s: Session) {
  const ctx = contextOf(s);
  el.hidden = !ctx;
  if (!ctx) return;
  const u = s.usage;
  const n = (v: number) => v.toLocaleString();
  el.dataset.level = ctx.level;
  el.innerHTML = `<span class="meter"><i></i></span><span class="num"></span>`;
  el.querySelector<HTMLElement>(".meter i")!.style.width = `${ctx.pct}%`;
  el.querySelector(".num")!.textContent = fmtTokens(ctx.tokens);
  const model = s.status?.model?.display_name ?? u?.model;
  el.title = [
    `Context: ${n(ctx.tokens)} of ${fmtTokens(ctx.window)} tokens (${Math.round(ctx.pct)}%)`,
    u ? `This conversation: ${n(u.input + u.cacheRead + u.cacheWrite)} input tokens (${n(u.cacheRead)} read from cache), ${n(u.output)} output` : "",
    [u ? `${u.requests} request${u.requests === 1 ? "" : "s"}` : "", model].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- plan usage limits ----------
// Claude Code reports the subscription's 5-hour and weekly usage to its status line;
// they're the account's, so the sidebar shows the latest any session reported.

let limits: RateLimits | null = null;
/** When Claude Code last reported the limits (ms). */
let limitsAt = 0;

function noteLimits(l: RateLimits) {
  limits = l;
  limitsAt = Date.now();
  renderLimits();
}

type LimitRow = { label: string; cls: "five" | "week"; pct: number; resetsAt: number };

/** The limit windows to show: those Claude Code reported and that haven't reset yet. */
function limitRows(): LimitRow[] {
  const now = Date.now() / 1000;
  const rows: LimitRow[] = [];
  for (const [label, cls, w] of [["5-hour", "five", limits?.five_hour], ["Weekly", "week", limits?.seven_day]] as const) {
    if (w && w.resets_at > now) rows.push({ label, cls, pct: Math.max(0, Math.min(100, w.used_percentage)), resetsAt: w.resets_at });
  }
  return rows;
}

/** "in 2 h 5 min" / "in 2 d 21 h" until `at` (s), and the clock time: "11:25", "tomorrow 09:25", "Sat 09:25". */
function resetWhen(at: number): { left: string; clock: string } {
  const secs = Math.max(0, at - Date.now() / 1000);
  const left =
    secs < 3600
      ? `${Math.max(1, Math.round(secs / 60))} min`
      : secs < 86400
        ? `${Math.floor(secs / 3600)} h ${Math.floor((secs % 3600) / 60)} min`
        : `${Math.floor(secs / 86400)} d ${Math.floor((secs % 86400) / 3600)} h`;
  const d = new Date(at * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(Date.now() + 86400_000).toDateString();
  const clock =
    d.toDateString() === new Date().toDateString()
      ? time
      : d.toDateString() === tomorrow
        ? `tomorrow ${time}`
        : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return { left: `in ${left}`, clock };
}

const limitLevel = (pct: number) => (pct >= 90 ? "full" : pct >= 70 ? "high" : "ok");

function renderLimits() {
  const el = $("#limits");
  const rows = limitRows();
  el.hidden = !rows.length;
  el.replaceChildren(
    ...rows.map((r) => {
      const row = document.createElement("div");
      row.className = `limit ${r.cls}`;
      row.dataset.level = limitLevel(r.pct);
      row.innerHTML = `<span class="l-name"></span><span class="meter"><i></i></span><span class="l-pct"></span>`;
      row.querySelector(".l-name")!.textContent = r.label;
      row.querySelector<HTMLElement>(".meter i")!.style.width = `${r.pct}%`;
      row.querySelector(".l-pct")!.textContent = `${Math.round(r.pct)}%`;
      return row;
    }),
  );
  // The collapsed sidebar's version: 5-hour as the outer ring, weekly inside it.
  const box = $("#limit-rings");
  box.hidden = !rows.length;
  for (const cls of ["five", "week"] as const) {
    const arc = box.querySelector<SVGCircleElement>(`.arc.${cls}`)!;
    const pct = rows.find((r) => r.cls === cls)?.pct ?? 0;
    arc.style.display = pct > 0 ? "" : "none"; // a round cap would still draw a dot at 0
    arc.style.strokeDasharray = `${pct} 100`;
    arc.dataset.level = limitLevel(pct);
  }
  if (limitPopFor) {
    if (rows.length) renderLimitPop();
    else closeLimitPop();
  }
}

// ---------- plan limits: details card ----------
// Hovering or focusing the limits (rings or bars) opens a card with each limit's use,
// when it resets, and how fresh the numbers are.

const limitPop = $("#limit-pop");
let limitPopFor: HTMLElement | null = null;
let limitPopClose = 0;

function renderLimitPop() {
  const anchor = limitPopFor;
  if (!anchor) return;
  const rows = limitRows();
  const ago = Math.round((Date.now() - limitsAt) / 60000);
  limitPop.innerHTML = `<div class="lp-head">Plan usage</div>`;
  for (const r of rows) {
    const { left, clock } = resetWhen(r.resetsAt);
    const row = document.createElement("div");
    row.className = `lp-row ${r.cls}`;
    row.dataset.level = limitLevel(r.pct);
    row.innerHTML = `<svg class="lp-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="track" cx="10" cy="10" r="7" /><circle class="arc" cx="10" cy="10" r="7" pathLength="100" /></svg>
      <div class="lp-main"><div class="lp-top"><span class="lp-name"></span><span class="lp-pct"></span></div>
      <div class="lp-bar"><i></i></div><div class="lp-reset"></div></div>`;
    row.querySelector(".lp-name")!.textContent = `${r.label} limit`;
    row.querySelector(".lp-pct")!.textContent = `${Math.round(r.pct)}% used`;
    row.querySelector<SVGCircleElement>(".arc")!.style.strokeDasharray = `${r.pct} 100`;
    row.querySelector<HTMLElement>(".lp-bar i")!.style.width = `${r.pct}%`;
    row.querySelector(".lp-reset")!.textContent = `Resets ${left} · ${clock}`;
    limitPop.appendChild(row);
  }
  const foot = document.createElement("div");
  foot.className = "lp-foot";
  foot.textContent = ago < 1 ? "Updated just now" : `Updated ${ago} min ago`;
  if (anchor.id === "limit-rings") {
    const legend = document.createElement("div");
    legend.textContent = "Outer ring 5-hour · inner ring weekly";
    foot.prepend(legend);
  }
  limitPop.appendChild(foot);
  // Beside the anchor, vertically centred on it and kept inside the window.
  limitPop.hidden = false;
  const a = anchor.getBoundingClientRect();
  const h = limitPop.offsetHeight;
  limitPop.style.left = `${Math.round(a.right + 10)}px`;
  limitPop.style.top = `${Math.round(Math.max(8, Math.min(innerHeight - h - 8, a.top + a.height / 2 - h / 2)))}px`;
}

function openLimitPop(anchor: HTMLElement) {
  clearTimeout(limitPopClose);
  if (!limitRows().length) return;
  limitPopFor = anchor;
  renderLimitPop();
}

function closeLimitPop() {
  clearTimeout(limitPopClose);
  limitPopFor = null;
  limitPop.hidden = true;
}

for (const anchor of [$("#limits"), $("#limit-rings")]) {
  anchor.addEventListener("mouseenter", () => openLimitPop(anchor));
  anchor.addEventListener("focus", () => openLimitPop(anchor));
  // A short grace period lets the pointer travel onto the card without it closing.
  anchor.addEventListener("mouseleave", () => (limitPopClose = window.setTimeout(closeLimitPop, 150)));
  anchor.addEventListener("blur", closeLimitPop);
  anchor.addEventListener("keydown", (e) => e.key === "Escape" && closeLimitPop());
}
limitPop.addEventListener("mouseenter", () => clearTimeout(limitPopClose));
limitPop.addEventListener("mouseleave", closeLimitPop);
// Keep the times current while it's open.
setInterval(() => limitPopFor && renderLimitPop(), 30_000);

setInterval(renderLimits, 60_000); // drop a window once it has reset

// Cheap to poll: a small status file, and only what Claude Code appended to the
// conversation since the last read.
setInterval(() => {
  if (document.hidden) return;
  for (const s of sessions) if (s.running) void s.refreshStatus().then(() => s.refreshUsage());
}, 2000);

// ---------- git branch ----------

async function refreshBranch(s: Session) {
  const b = await invoke<string | null>("git_branch", { cwd: dirOf(s.opts) }).catch(() => null);
  s.setBranch(b);
}
// Polled while the window is visible; catches up as soon as it's shown again.
setInterval(() => !document.hidden && sessions.forEach((s) => void refreshBranch(s)), 4000);
document.addEventListener("visibilitychange", () => !document.hidden && sessions.forEach((s) => void refreshBranch(s)));

// ---------- search ----------

const searchInput = $<HTMLInputElement>("#search-input");
const searchBar = $("#searchbar");
/** Where the search bar lives while no pane holds it. */
const searchHome = searchBar.parentElement!;

function openSearch() {
  if (!active) return;
  const bar = searchBar;
  active.el.appendChild(bar);
  bar.hidden = false;
  const sel = active.term.getSelection();
  if (sel && !sel.includes("\n")) searchInput.value = sel;
  searchInput.select();
  searchInput.focus();
  if (searchInput.value) runSearch(true, true);
}

function closeSearch() {
  searchBar.hidden = true;
  $("#search-count").textContent = "";
  active?.search.clearDecorations();
  active?.term.clearSelection();
  active?.term.focus();
}

function moveSearchTo(s: Session, prev: Session | null) {
  prev?.search.clearDecorations();
  s.el.appendChild(searchBar);
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
    li.addEventListener("click", () => startSession({ ...defaultsFor(dir), cwd: dir }));
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
for (const sel of ["#f-model", "#f-perm", "#f-conv", "#s-theme", "#s-line"]) {
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
  cwdTimer = window.setTimeout(() => {
    applyFolderDefaults(cwdInput.value.trim());
    void refreshConversations();
  }, 300);
});

/** Fills the dialog's options from the folder's own defaults (or the last used ones). */
function applyFolderDefaults(cwd: string) {
  const d = defaultsFor(cwd);
  const own = !!projectDefaults()[cwd];
  setSegment("#f-model", d.model);
  setSegment("#f-perm", d.permissionMode);
  $<HTMLInputElement>("#f-extra").value = d.extra;
  $("#f-defaults-hint").textContent = own ? `Using the options you last used in ${basename(cwd)}.` : "";
  void refreshWorktreeField();
}

let worktreeReq = 0;
/** The worktree option only makes sense inside a git repository. */
async function refreshWorktreeField() {
  const cwd = cwdInput.value.trim();
  const req = ++worktreeReq;
  const box = $<HTMLInputElement>("#f-worktree");
  const repo = cwd ? await invoke<WorktreeInfo | null>("worktree_info", { cwd, name: "x" }).catch(() => null) : null;
  if (req !== worktreeReq) return;
  box.disabled = !repo;
  if (!repo) box.checked = false;
  $("#f-worktree-row").classList.toggle("disabled", !repo);
  $("#f-wt-hint").textContent = repo
    ? "Claude Code creates a new branch and folder under .claude/worktrees, so this session's edits don't touch your working copy or other sessions."
    : "Only for folders inside a git repository.";
  $("#f-wt-name-row").hidden = !box.checked;
}

function suggestWorktreeName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `desk-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

$("#f-worktree").addEventListener("change", () => {
  const on = $<HTMLInputElement>("#f-worktree").checked;
  $("#f-wt-name-row").hidden = !on;
  if (on && !$<HTMLInputElement>("#f-wt-name").value) $<HTMLInputElement>("#f-wt-name").value = suggestWorktreeName();
});

function openNewDialog(prefill?: string) {
  const dlg = $<HTMLDialogElement>("#new-dialog");
  cwdInput.value = prefill ?? recentFolders()[0] ?? "";
  setSegment("#f-conv", lastLaunch.conversation);
  $<HTMLInputElement>("#f-worktree").checked = false;
  $<HTMLInputElement>("#f-wt-name").value = "";
  applyFolderDefaults(cwdInput.value.trim());
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
      applyFolderDefaults(dir);
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
    applyFolderDefaults(dir);
    void refreshConversations();
  }
});

$("#new-form").addEventListener("submit", (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "ok") return;
  const wtName = $<HTMLInputElement>("#f-wt-name").value.trim();
  if ($<HTMLInputElement>("#f-worktree").checked && !/^[A-Za-z0-9._-]{1,60}$/.test(wtName)) {
    e.preventDefault();
    $("#f-wt-hint").textContent = "Use letters, digits, '.', '_' or '-' for the worktree name.";
    return;
  }
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
  const cwd = cwdInput.value.trim();
  rememberDefaults(cwd, lastLaunch);
  const worktree = $<HTMLInputElement>("#f-worktree").checked ? $<HTMLInputElement>("#f-wt-name").value.trim() : undefined;
  startSession({
    ...lastLaunch,
    conversation,
    resumeId: conversation === "resume" ? resumed?.id : undefined,
    resumeTitle: conversation === "resume" ? resumed?.title : undefined,
    cwd,
    worktree,
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
  $<HTMLSelectElement>("#s-termfont").value = settings.font;
  $<HTMLInputElement>("#s-customfont").value = settings.customFont;
  updateFontFields();
  const dlg = $<HTMLDialogElement>("#settings-dialog");
  dlg.returnValue = "";
  dlg.showModal();
}

$<HTMLDialogElement>("#settings-dialog").addEventListener("close", () => {
  if ($<HTMLDialogElement>("#settings-dialog").returnValue !== "ok") return;
  const font = Number($<HTMLInputElement>("#s-font").value);
  settings = {
    binary: $<HTMLInputElement>("#s-binary").value.trim(),
    font: $<HTMLSelectElement>("#s-termfont").value || DEFAULT_FONT,
    customFont: $<HTMLInputElement>("#s-customfont").value.trim(),
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
  void Promise.all(["400", "600"].map((w) => document.fonts.load(`${w} ${fontPx()}px "${termFont()}"`)))
    .catch(() => {})
    .then(() => {
      for (const s of sessions) {
        s.term.options.fontFamily = fontStack(termFont());
        s.term.options.fontWeightBold = boldWeight(termFont());
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
    if (manual) status.textContent = `Switchyard ${await getVersion()} is up to date.`;
    return;
  }
  pendingUpdate = update;
  if (manual) status.textContent = `Switchyard ${update.version} is available.`;
  if (manual || updateDismissed !== update.version) showUpdateToast(update);
}

function showUpdateToast(update: Update) {
  const toastEl = $("#update-toast");
  toastEl.querySelector(".ut-text")!.textContent =
    `Switchyard ${update.version} is out (you have ${update.currentVersion})`;
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
    !(await askToConfirm(
      settings.restore
        ? `Install the update now? Your ${running} session${running === 1 ? "" : "s"} will reopen after the restart and continue where they left off.`
        : `Restarting ends ${running} running Claude session${running === 1 ? "" : "s"}. Install the update now?`,
      "Install and restart",
    ))
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
void getVersion().then((v) => ($("#s-version").textContent = `Switchyard ${v}`)).catch(() => {});

// Check 10 s after opening (as Fleet does), then every 6 hours for windows left open.
setTimeout(() => void lookForUpdate(), 10_000);
setInterval(() => void lookForUpdate(), 6 * 60 * 60 * 1000);

// The font picker: bundled fonts, plus "Custom…" for any font installed on this computer.
{
  const select = $<HTMLSelectElement>("#s-termfont");
  for (const f of BUNDLED_FONTS) {
    const opt = document.createElement("option");
    opt.value = f.name;
    opt.textContent = f.name === DEFAULT_FONT ? `${f.name} (default)` : f.name;
    opt.style.fontFamily = fontStack(f.name);
    select.appendChild(opt);
  }
  const custom = document.createElement("option");
  custom.value = CUSTOM_FONT;
  custom.textContent = "Custom… (a font installed on this computer)";
  select.appendChild(custom);
  select.addEventListener("change", updateFontFields);
  $("#s-customfont").addEventListener("input", updateFontFields);
}

function updateFontFields() {
  const choice = $<HTMLSelectElement>("#s-termfont").value;
  const isCustom = choice === CUSTOM_FONT;
  const name = $<HTMLInputElement>("#s-customfont").value.trim();
  $("#s-customfont-row").hidden = !isCustom;
  const family = isCustom ? name || DEFAULT_FONT : choice;
  const preview = $("#s-fontpreview");
  preview.style.fontFamily = fontStack(family);
  preview.style.fontSize = `${Math.max(12, fontPx())}px`;
  const hint = $("#s-fonthint");
  if (isCustom && name && !fontAvailable(name)) {
    hint.textContent = `"${name}" doesn't seem to be installed; the preview shows the fallback. Use the font's exact name, e.g. "Berkeley Mono" or "FiraCode Nerd Font Mono".`;
    hint.classList.add("warn");
  } else {
    hint.textContent = isCustom
      ? "Any monospaced font installed on this computer, by its exact name."
      : "Ligatures (e.g. in Fira Code) aren't drawn: the terminal shows each character separately.";
    hint.classList.remove("warn");
  }
}

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
  if (mod && ["KeyT", "KeyW", "Comma", "Backslash", "KeyF", "Enter", "KeyB", "KeyK", "KeyG", "KeyJ", "KeyO"].includes(e.code))
    return true;
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
  else if (e.code === "KeyK") openPalette();
  else if (e.code === "KeyG" && active) toggleChanges();
  else if (e.code === "KeyJ") openBroadcast();
  else if (e.code === "KeyO") void openHistory();
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

// ---------- changes panel (git) ----------

interface GitChange {
  path: string;
  status: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

let changesFor: Session | null = null;
let changesSelected: string | null = null;
/** What the list and diff currently show, so unchanged refreshes skip rebuilding the DOM
 *  (re-rendering a large diff takes a few hundred ms on the UI thread). */
let changesShown = "";
let diffShown = "";
let changesTimer = 0;
let changesBusy = false;
/** How long the last `git status` took; refreshes back off on big repositories. */
let changesCostMs = 0;
let changesLast = 0;

const changesOpen = () => document.body.classList.contains("changes-open");

function toggleChanges(force?: boolean) {
  const open = force ?? !changesOpen();
  document.body.classList.toggle("changes-open", open);
  $("#changes").hidden = !open;
  $("#tb-changes").classList.toggle("on", open);
  store.set("ui2", { changesOpen: open });
  if (open) void refreshChanges(true);
  requestAnimationFrame(() => sessions.forEach((s) => s.refit()));
}

function scheduleChangesRefresh(ms = 0) {
  clearTimeout(changesTimer);
  changesTimer = window.setTimeout(() => void refreshChanges(false), ms);
}

const STATUS_NAMES: Record<string, string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", U: "Conflict", "?": "New" };

async function refreshChanges(reset: boolean) {
  if (!changesOpen() || changesBusy) return;
  const s = active;
  const list = $("#ch-files");
  const info = $("#ch-info");
  if (!s) {
    list.innerHTML = "";
    info.textContent = "No session";
    return;
  }
  if (reset || changesFor !== s) {
    changesFor = s;
    changesSelected = null;
    changesShown = "";
    diffShown = "";
    $("#ch-diff").textContent = "";
    $("#ch-diff").hidden = true;
  }
  changesBusy = true;
  const t0 = performance.now();
  try {
    const res = await invoke<{ branch: string | null; files: GitChange[] }>("git_changes", { dir: dirOf(s.opts) });
    changesCostMs = performance.now() - t0;
    changesLast = performance.now();
    if (changesFor !== s) return;
    $("#ch-title").textContent = `Changes · ${displayName(s.opts)}`;
    info.textContent = res.files.length
      ? `${res.files.length} file${res.files.length === 1 ? "" : "s"} changed${res.branch ? ` on ${res.branch}` : ""}`
      : `No changes${res.branch ? ` on ${res.branch}` : ""}`;
    const shown = JSON.stringify(res.files);
    const listChanged = shown !== changesShown;
    changesShown = shown;
    if (listChanged) {
      const frag = document.createDocumentFragment();
      for (const f of res.files) {
        const code = f.status === "??" ? "?" : (f.status.trim()[0] ?? "M");
        const li = document.createElement("li");
        li.className = f.path === changesSelected ? "on" : "";
        li.innerHTML = `<span class="st st-${code === "?" ? "new" : code}"></span><span class="file"><span class="fname"></span><span class="fdir"></span></span><span class="nums"></span>`;
        li.querySelector(".st")!.textContent = code === "?" ? "U" : code;
        (li.querySelector(".st") as HTMLElement).title = STATUS_NAMES[code] ?? f.status;
        const slash = f.path.lastIndexOf("/");
        li.querySelector(".fname")!.textContent = f.path.slice(slash + 1);
        li.querySelector(".fdir")!.textContent = slash > 0 ? f.path.slice(0, slash) : "";
        li.querySelector(".nums")!.innerHTML = f.binary
          ? `<span class="bin">binary</span>`
          : `<span class="add">+${f.added ?? 0}</span><span class="del">−${f.removed ?? 0}</span>`;
        li.title = f.path;
        li.addEventListener("click", () => {
          changesSelected = f.path;
          list.querySelectorAll("li").forEach((x) => x.classList.toggle("on", x === li));
          void showDiff(s, f);
        });
        frag.appendChild(li);
      }
      list.replaceChildren(frag);
    }
    if (changesSelected) {
      const f = res.files.find((x) => x.path === changesSelected);
      if (f) void showDiff(s, f);
      else {
        changesSelected = null;
        $("#ch-diff").hidden = true;
      }
    }
  } catch (err) {
    if (changesFor === s) {
      list.innerHTML = "";
      changesShown = "";
      const msg = String(err);
      info.textContent = /not a git repository/i.test(msg) ? "This folder isn't a git repository." : msg;
    }
  } finally {
    changesBusy = false;
  }
}

async function showDiff(s: Session, f: GitChange) {
  const pre = $("#ch-diff");
  pre.hidden = false;
  const text = await invoke<string>("git_diff", { dir: dirOf(s.opts), path: f.path, untracked: f.status === "??" }).catch(
    (e) => `Couldn't load the diff: ${e}`,
  );
  if (changesFor !== s || changesSelected !== f.path) return;
  const key = `${f.path}\0${text}`;
  if (key === diffShown) return; // unchanged since the last refresh
  diffShown = key;
  const frag = document.createDocumentFragment();
  for (const line of text.split("\n")) {
    const div = document.createElement("div");
    div.className =
      line.startsWith("@@") ? "hunk" : line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("diff ") || line.startsWith("index ") ? "meta" : "";
    div.textContent = line || " ";
    frag.appendChild(div);
  }
  pre.replaceChildren(frag);
}

// Refresh while open and the window is in front: every 4 s, or at least 20x as long as
// the last refresh took, so a very large repository doesn't keep git busy.
setInterval(() => {
  if (!changesOpen() || document.hidden || !windowFocused) return;
  if (performance.now() - changesLast >= Math.max(4000, changesCostMs * 20)) void refreshChanges(false);
}, 1000);
$("#tb-changes").addEventListener("click", () => toggleChanges());
$("#ch-close").addEventListener("click", () => toggleChanges(false));
$("#ch-refresh").addEventListener("click", () => void refreshChanges(false));

// ---------- broadcast ----------

function openBroadcast() {
  const list = $("#bc-sessions");
  list.innerHTML = "";
  const running = sessions.filter((s) => s.running);
  for (const s of sessions) {
    const label = document.createElement("label");
    label.className = "bc-item";
    label.innerHTML = `<input type="checkbox" /><span class="dot"></span><span class="bc-name"></span><span class="bc-path"></span>`;
    const box = label.querySelector("input")!;
    box.checked = s.running;
    box.disabled = !s.running;
    box.dataset.idx = String(sessions.indexOf(s));
    label.querySelector(".bc-name")!.textContent = displayName(s.opts);
    label.querySelector(".bc-path")!.textContent = s.running ? dirOf(s.opts) : "not running";
    if (s.state) label.dataset.state = s.state;
    list.appendChild(label);
  }
  $("#bc-hint").textContent = running.length ? "" : "No running sessions.";
  const dlg = $<HTMLDialogElement>("#broadcast-dialog");
  dlg.returnValue = "";
  dlg.showModal();
  $<HTMLTextAreaElement>("#bc-text").focus();
}

$<HTMLTextAreaElement>("#bc-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    $<HTMLFormElement>("#broadcast-form").requestSubmit($("#broadcast-form button.primary"));
  }
});

$<HTMLDialogElement>("#broadcast-dialog").addEventListener("close", () => {
  const dlg = $<HTMLDialogElement>("#broadcast-dialog");
  if (dlg.returnValue !== "ok") return;
  const text = $<HTMLTextAreaElement>("#bc-text").value;
  if (!text.trim()) return;
  const targets = [...document.querySelectorAll<HTMLInputElement>("#bc-sessions input:checked")]
    .map((b) => sessions[Number(b.dataset.idx)])
    .filter((s) => s?.running);
  for (const s of targets) s.sendPrompt(text);
  $<HTMLTextAreaElement>("#bc-text").value = "";
  if (active) toast(active.el, `Sent to ${targets.length} session${targets.length === 1 ? "" : "s"}`);
});

// ---------- session name & colour ----------

let editing: Session | null = null;

function openSessionDialog(s: Session) {
  editing = s;
  $<HTMLInputElement>("#ss-name").value = s.opts.name ?? "";
  $<HTMLInputElement>("#ss-name").placeholder = displayName({ ...s.opts, name: undefined });
  $("#ss-path").textContent = dirOf(s.opts);
  const sw = $("#ss-colors");
  sw.innerHTML = "";
  for (const key of ["", ...Object.keys(SESSION_COLORS)]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + ((s.opts.color ?? "") === key ? " on" : "");
    b.dataset.v = key;
    b.title = key ? key[0].toUpperCase() + key.slice(1) : "No colour";
    if (key) b.style.background = SESSION_COLORS[key];
    b.addEventListener("click", () => sw.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("on", x === b)));
    sw.appendChild(b);
  }
  const dlg = $<HTMLDialogElement>("#session-dialog");
  dlg.returnValue = "";
  dlg.showModal();
  $<HTMLInputElement>("#ss-name").select();
}

$<HTMLDialogElement>("#session-dialog").addEventListener("close", () => {
  const s = editing;
  editing = null;
  if (!s || $<HTMLDialogElement>("#session-dialog").returnValue !== "ok") return;
  const name = $<HTMLInputElement>("#ss-name").value.trim();
  s.opts.name = name || undefined;
  s.opts.color = $("#ss-colors").querySelector<HTMLButtonElement>(".swatch.on")?.dataset.v || undefined;
  s.applyIdentity();
  saveWorkspace();
});

// ---------- reordering tabs by dragging ----------
// (Pointer-based: the web view's own drag and drop is taken by file drops.)

const tabDrag = { session: null as Session | null, startY: 0, moved: false, suppressClick: false };

function startTabDrag(e: PointerEvent, s: Session) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
  tabDrag.session = s;
  tabDrag.startY = e.clientY;
  tabDrag.moved = false;
  tabDrag.suppressClick = false;
  const move = (ev: PointerEvent) => {
    if (!tabDrag.moved && Math.abs(ev.clientY - tabDrag.startY) < 5) return;
    if (!tabDrag.moved) {
      tabDrag.moved = true;
      s.tab.classList.add("dragging");
      s.tab.setPointerCapture(ev.pointerId);
    }
    const list = $("#tabs");
    const others = [...list.children].filter((x) => x !== s.tab) as HTMLElement[];
    const before = others.find((x) => ev.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
    if (before) list.insertBefore(s.tab, before);
    else list.appendChild(s.tab);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    s.tab.classList.remove("dragging");
    if (!tabDrag.moved) return;
    tabDrag.suppressClick = true;
    setTimeout(() => (tabDrag.suppressClick = false), 0);
    // Adopt the new order everywhere: sessions, panes (grid order), numbering.
    const order = [...$("#tabs").children];
    sessions.sort((a, b) => order.indexOf(a.tab) - order.indexOf(b.tab));
    for (const x of sessions) $("#terminals").appendChild(x.el);
    applyLayout();
    updateTopbar();
    saveWorkspace();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------- conversation history (every project) ----------

interface HistoryItem extends Conversation {
  cwd?: string;
}
let history: HistoryItem[] = [];
let historyPick = 0;

async function openHistory() {
  const dlg = $<HTMLDialogElement>("#history-dialog");
  const input = $<HTMLInputElement>("#hist-q");
  input.value = "";
  $("#hist-list").innerHTML = "";
  $("#hist-hint").textContent = "Loading…";
  dlg.returnValue = "";
  dlg.showModal();
  input.focus();
  history = await invoke<HistoryItem[]>("list_all_conversations", { limit: 400 }).catch(() => []);
  renderHistory();
}

function historyMatches(): HistoryItem[] {
  const q = $<HTMLInputElement>("#hist-q").value.trim().toLowerCase();
  if (!q) return history;
  const words = q.split(/\s+/);
  return history.filter((h) => {
    const hay = `${h.title} ${h.cwd ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function renderHistory() {
  const items = historyMatches();
  historyPick = Math.min(historyPick, Math.max(0, items.length - 1));
  $("#hist-hint").textContent = history.length
    ? `${items.length} of ${history.length} conversations`
    : "No conversations found in ~/.claude/projects.";
  const frag = document.createDocumentFragment();
  items.slice(0, 200).forEach((h, i) => {
    const li = document.createElement("li");
    li.className = i === historyPick ? "on" : "";
    li.innerHTML = `${icon("history")}<span class="meta"><span class="name"></span><span class="sub"></span></span>`;
    li.querySelector(".name")!.textContent = h.title;
    li.querySelector(".sub")!.textContent = `${h.cwd ? basename(h.cwd) : "unknown folder"} · ${timeAgo(h.modifiedMs)}${h.cwd ? ` · ${h.cwd}` : ""}`;
    li.addEventListener("click", () => {
      historyPick = i;
      $("#hist-list").querySelectorAll("li").forEach((x, j) => x.classList.toggle("on", j === i));
    });
    li.addEventListener("dblclick", () => openHistoryItem(h));
    frag.appendChild(li);
  });
  $("#hist-list").replaceChildren(frag);
}

function openHistoryItem(h: HistoryItem) {
  $<HTMLDialogElement>("#history-dialog").close("cancel");
  if (!h.cwd) return;
  startSession({ ...defaultsFor(h.cwd), cwd: h.cwd, conversation: "resume", resumeId: h.id, resumeTitle: h.title });
}

$("#hist-q").addEventListener("input", () => {
  historyPick = 0;
  renderHistory();
});
$("#hist-q").addEventListener("keydown", (e) => {
  const items = historyMatches();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    historyPick = Math.max(0, Math.min(items.length - 1, historyPick + (e.key === "ArrowDown" ? 1 : -1)));
    renderHistory();
    $("#hist-list").querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (items[historyPick]) openHistoryItem(items[historyPick]);
  }
});
$("#history-btn").addEventListener("click", () => void openHistory());

// ---------- per-project defaults ----------

type ProjectDefaults = Pick<LaunchOptions, "model" | "permissionMode" | "extra">;

function projectDefaults(): Record<string, ProjectDefaults> {
  return store.get<Record<string, ProjectDefaults>>("projectDefaults", {});
}

/** Launch options to use for a folder: its own last options, else the last used ones. */
function defaultsFor(cwd: string): SavedLaunch {
  const own = projectDefaults()[cwd];
  return own ? { ...lastLaunch, ...own } : lastLaunch;
}

function rememberDefaults(cwd: string, o: ProjectDefaults) {
  const all = projectDefaults();
  all[cwd] = { model: o.model, permissionMode: o.permissionMode, extra: o.extra };
  // Keep the most recent 100 folders.
  const keys = Object.keys(all);
  if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete all[k];
  store.set("projectDefaults", all);
}

// ---------- command palette ----------

interface PaletteItem {
  label: string;
  hint?: string;
  run: () => void;
}
let paletteItems: PaletteItem[] = [];
let palettePick = 0;

function paletteCommands(): PaletteItem[] {
  const mod = isMac ? "⌘" : "Ctrl+Shift+";
  const items: PaletteItem[] = sessions.map((s, i) => ({
    label: `Go to ${displayName(s.opts)}`,
    hint: [stateLabel(s.state, s.blockedKind()), i < 9 ? `${mod}${i + 1}` : ""].filter(Boolean).join(" · "),
    run: () => activate(s),
  }));
  const add = (label: string, run: () => void, hint?: string, when = true) => when && items.push({ label, run, hint });
  add("New session…", () => openNewDialog(), `${mod}T`);
  add("Open conversation from history…", () => void openHistory(), `${mod}O`);
  add("Broadcast a prompt to sessions…", openBroadcast, `${mod}J`, sessions.some((s) => s.running));
  add(changesOpen() ? "Hide changes panel" : "Show changes panel", () => toggleChanges(), `${mod}G`, !!active);
  add("Search terminal", openSearch, `${mod}F`, !!active);
  if (active) {
    const a = active;
    add(`Rename / colour “${displayName(a.opts)}”…`, () => openSessionDialog(a));
    add(`Restart “${displayName(a.opts)}”`, () => a.restart());
    add(`Close “${displayName(a.opts)}”`, () => closeSession(a), `${mod}W`);
    add(zoomed === a ? "Restore layout" : "Maximise pane", () => toggleZoom(a), isMac ? "⌘↵" : "Ctrl+Shift+↵", isSplit());
  }
  for (const l of LAYOUTS) add(`Layout: ${LAYOUT_NAMES[l]}`, () => setLayout(l), l === layout ? "current" : undefined);
  add(sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", toggleSidebar, `${mod}B`);
  for (const t of ["dark", "light", "system"] as ThemePref[]) {
    add(`Theme: ${t[0].toUpperCase()}${t.slice(1)}`, () => {
      settings.theme = t;
      store.set("settings", settings);
      applyTheme();
    }, settings.theme === t ? "current" : undefined);
  }
  add("Settings…", openSettings, `${mod},`);
  add("Check for updates", () => {
    openSettings();
    void lookForUpdate(true);
  });
  return items;
}

/** Subsequence match with a score that prefers word starts and contiguous runs. */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of query.toLowerCase()) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (found === 0 || /[\s·“(:/-]/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

function openPalette() {
  if (document.querySelector("dialog[open]")) return;
  paletteItems = paletteCommands();
  palettePick = 0;
  const input = $<HTMLInputElement>("#pal-q");
  input.value = "";
  renderPalette();
  const dlg = $<HTMLDialogElement>("#palette-dialog");
  dlg.showModal();
  input.focus();
}

function paletteMatches(): PaletteItem[] {
  const q = $<HTMLInputElement>("#pal-q").value.trim();
  return paletteItems
    .map((item, i) => ({ item, i, score: fuzzyScore(item.label, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.item);
}

function renderPalette() {
  const items = paletteMatches();
  palettePick = Math.min(palettePick, Math.max(0, items.length - 1));
  const frag = document.createDocumentFragment();
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = i === palettePick ? "on" : "";
    li.innerHTML = `<span class="pal-label"></span><span class="pal-hint"></span>`;
    li.querySelector(".pal-label")!.textContent = item.label;
    li.querySelector(".pal-hint")!.textContent = item.hint ?? "";
    li.addEventListener("mousemove", () => {
      if (palettePick === i) return;
      palettePick = i;
      $("#pal-list").querySelectorAll("li").forEach((x, j) => x.classList.toggle("on", j === i));
    });
    li.addEventListener("click", () => runPalette(item));
    frag.appendChild(li);
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No matching commands";
    frag.appendChild(li);
  }
  $("#pal-list").replaceChildren(frag);
}

function runPalette(item: PaletteItem) {
  $<HTMLDialogElement>("#palette-dialog").close();
  // Let the palette close (and focus return) before the command opens anything.
  requestAnimationFrame(() => item.run());
}

$("#pal-q").addEventListener("input", () => {
  palettePick = 0;
  renderPalette();
});
$("#pal-q").addEventListener("keydown", (e) => {
  const items = paletteMatches();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    palettePick = (palettePick + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length);
    renderPalette();
    $("#pal-list").querySelector("li.on")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (items[palettePick]) runPalette(items[palettePick]);
  }
});
$("#palette-dialog").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) $<HTMLDialogElement>("#palette-dialog").close();
});
/** Whether keystrokes are going to a text field (a terminal's own input aside). */
function typingElsewhere(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el.classList.contains("xterm-helper-textarea")) return false;
  return el.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");
}

// Keystrokes must land in a terminal: give focus back to the active session whenever a
// dialog closes (the browser would return it to the button that opened the dialog),
// unless another dialog is open or a text field has focus.
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("close", () =>
    requestAnimationFrame(() => {
      if (document.querySelector("dialog[open]") || typingElsewhere()) return;
      active?.term.focus();
    }),
  );
}

// ---------- drag & drop ----------

// Dropped files go to the session under the pointer: its pane (any layout) or its tab
// in the sidebar; elsewhere, the active session. A running session gets the paths
// typed in, like a terminal does; with none running there, the drop opens a new
// session in that folder. While dragging, an outline shows where the drop will land.

const dropHint = $("#drop-hint");
let dragCount = 0;
let dropTab: HTMLElement | null = null;

/** The session a drop at (x, y) in page pixels goes to. */
function dropTargetAt(x: number, y: number): Session | null {
  const el = document.elementFromPoint(x, y);
  const pane = el?.closest(".term");
  const tab = el?.closest("#tabs li");
  return sessions.find((s) => s.el === pane || s.tab === tab) ?? active;
}

function showDropHint(x: number, y: number) {
  const s = dropTargetAt(x, y);
  // Over the pane if it's on screen; otherwise (a background tab's session) over the
  // whole session area, which is where it will show once the drop switches to it.
  const visible = !!s && s.el.offsetParent !== null;
  const area = visible ? s.el : $("#terminals");
  // A session that isn't on screen: cover what is, so it's clear where the drop goes.
  dropHint.classList.toggle("elsewhere", !visible);
  const r = area.getBoundingClientRect();
  Object.assign(dropHint.style, { left: `${r.left + 6}px`, top: `${r.top + 6}px`, width: `${r.width - 12}px`, height: `${r.height - 12}px` });
  const paths = dragCount === 1 ? "the path" : `${dragCount} paths`;
  dropHint.textContent =
    s?.running
      ? `Insert ${paths} into “${displayName(s.opts)}”${visible ? "" : " (switches to it)"}`
      : "Drop to open a new session in this folder";
  dropHint.hidden = false;
  const tab = s?.running ? s.tab : null;
  if (dropTab !== tab) {
    dropTab?.classList.remove("drop-target");
    tab?.classList.add("drop-target");
    dropTab = tab;
  }
}

function hideDropHint() {
  dropHint.hidden = true;
  dropTab?.classList.remove("drop-target");
  dropTab = null;
}

void getCurrentWebview().onDragDropEvent((ev) => {
  const p = ev.payload;
  if (p.type === "leave") return hideDropHint();
  if (p.type === "enter") dragCount = p.paths.length;
  // Tauri reports the pointer in physical pixels.
  const { x, y } = p.position.toLogical(devicePixelRatio);
  if (p.type !== "drop") return showDropHint(x, y);
  hideDropHint();
  if (p.paths.length === 0) return;
  const target = dropTargetAt(x, y);
  if (target?.running) {
    if (target !== active) activate(target);
    target.write(p.paths.map(shellQuote).join(" ") + " ");
    target.term.focus();
  } else {
    openNewDialog(p.paths[0]);
  }
});

// ---------- boot ----------

void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  windowFocused = focused;
  // Coming back to the window: type into the active session unless something else has focus.
  if (focused && active && !document.querySelector("dialog[open]") && !typingElsewhere()) active.term.focus();
  if (focused && active) active.clearAttention();
  if (focused && changesOpen()) scheduleChangesRefresh();
});

$("#new-btn").addEventListener("click", () => openNewDialog());
$("#empty-open").addEventListener("click", async () => {
  const dir = await pickFolder();
  if (dir) startSession({ ...defaultsFor(dir), cwd: dir });
});
$("#settings-btn").addEventListener("click", openSettings);
$("#new-kbd").textContent = isMac ? "⌘T" : "Ctrl⇧T";
$("#empty-new").addEventListener("click", () => openNewDialog());
$("#tb-search").title = `Search terminal (${isMac ? "⌘F" : "Ctrl+Shift+F"})`;
{
  const mod = isMac ? "⌘" : "Ctrl+Shift+";
  $("#palette-btn").addEventListener("click", openPalette);
  $("#palette-btn").title = `Commands (${mod}K)`;
  $("#history-btn").title = `Conversation history (${mod}O)`;
  $("#tb-broadcast").addEventListener("click", openBroadcast);
  $("#tb-broadcast").title = `Broadcast a prompt to sessions (${mod}J)`;
  $("#tb-changes").title = `Changes (${mod}G)`;
  $("#bc-kbd").textContent = isMac ? "⌘↵" : "Ctrl+↵";
}
if (isMac) document.body.classList.add("mac");

// Load the bundled fonts up front so xterm measures the real glyphs.
const fontsReady = Promise.all(
  ["400", "600"].map((w) => document.fonts.load(`${w} ${fontPx()}px "${termFont()}"`)),
).catch(() => {});

for (const b of document.querySelectorAll<HTMLButtonElement>("#layout-switch button")) {
  b.addEventListener("click", () => setLayout(b.dataset.layout as Layout));
  b.title += ` (${isMac ? "⌘\\" : "Ctrl+Shift+\\"} to cycle)`;
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("dialog .cancel")) {
  btn.addEventListener("click", () => btn.closest("dialog")!.close("cancel"));
}

// ---------- window buttons (Windows) ----------
// There the window has no system frame (src-tauri/src/lib.rs), so the app draws its
// own minimise, maximise/restore and close buttons at the top right. macOS and Linux
// keep their native ones.

if (isWindows) {
  document.body.classList.add("custom-titlebar");
  const controls = $("#win-controls");
  controls.hidden = false;
  const win = getCurrentWindow();
  const maxBtn = controls.querySelector<HTMLButtonElement>('[data-win="max"]')!;
  const syncMaximized = async () => {
    const max = await win.isMaximized().catch(() => false);
    controls.classList.toggle("maximized", max);
    maxBtn.title = maxBtn.ariaLabel = max ? "Restore" : "Maximise";
  };
  controls.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.win;
    if (act === "min") void win.minimize().catch(() => {});
    else if (act === "max") void win.toggleMaximize().catch(() => {});
    else if (act === "close") void win.close().catch(() => {});
  });
  void win.onResized(() => void syncMaximized());
  void syncMaximized();
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
if (store.get("ui2", { changesOpen: false }).changesOpen) toggleChanges(true);
// Restored terminals must measure the real font, so wait for it first.
void fontsReady.then(restoreWorkspace);
void checkCli();
