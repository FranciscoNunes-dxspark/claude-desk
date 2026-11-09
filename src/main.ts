import "@xterm/xterm/css/xterm.css";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "./style.css";

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

// ---------- persisted settings ----------

interface Settings {
  binary: string;
  fontSize: number;
}

interface LaunchOptions {
  cwd: string;
  model: string;
  permissionMode: string;
  continueLast: boolean;
  extra: string;
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

let settings: Settings = store.get("settings", { binary: "", fontSize: 13 });
let lastLaunch: Omit<LaunchOptions, "cwd"> = store.get("lastLaunch", {
  model: "",
  permissionMode: "",
  continueLast: false,
  extra: "",
});

function recentFolders(): string[] {
  return store.getList("recent");
}
function pushRecent(dir: string) {
  store.set("recent", [dir, ...recentFolders().filter((d) => d !== dir)].slice(0, 8));
}

// ---------- helpers ----------

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const isMac = navigator.platform.toUpperCase().includes("MAC");
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

function buildArgs(o: LaunchOptions): string[] {
  const args: string[] = [];
  if (o.model) args.push("--model", o.model);
  if (o.permissionMode) args.push("--permission-mode", o.permissionMode);
  if (o.continueLast) args.push("--continue");
  return args.concat(splitArgs(o.extra));
}

function shellQuote(path: string) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

const theme = {
  background: "#141413",
  foreground: "#e8e6dc",
  cursor: "#d97757",
  cursorAccent: "#141413",
  selectionBackground: "#d9775750",
  scrollbarSliderBackground: "#ffffff1a",
  scrollbarSliderHoverBackground: "#ffffff2a",
  black: "#262624",
  red: "#e5736a",
  green: "#8fbf7f",
  yellow: "#e0b86b",
  blue: "#7aa6da",
  magenta: "#c397d8",
  cyan: "#70c0b1",
  white: "#d8d6cc",
  brightBlack: "#6b6a65",
  brightRed: "#f08a80",
  brightGreen: "#a6d394",
  brightYellow: "#f0cb82",
  brightBlue: "#94bbe8",
  brightMagenta: "#d4ade6",
  brightCyan: "#8ad4c6",
  brightWhite: "#faf9f5",
};

// ---------- sessions ----------

class Session {
  readonly key = crypto.randomUUID();
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  readonly fit = new FitAddon();
  readonly tab: HTMLLIElement;
  private ptyId: number | null = null;
  private restartPending = false;
  private banner: HTMLDivElement | null = null;
  private resizeObs: ResizeObserver;

  constructor(readonly opts: LaunchOptions) {
    this.el = document.createElement("div");
    this.el.className = "term";
    $("#terminals").appendChild(this.el);

    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: settings.fontSize,
      fontWeight: "400",
      fontWeightBold: "600",
      lineHeight: 1.2,
      cursorStyle: "bar",
      cursorWidth: 2,
      minimumContrastRatio: 1,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10000,
      macOptionIsMeta: true,
      theme,
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => void openUrl(uri)));
    this.term.open(this.el);

    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    this.term.onData((data) => this.write(data));
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyId != null) void invoke("pty_resize", { id: this.ptyId, cols, rows }).catch(() => {});
    });
    this.resizeObs = new ResizeObserver(() => this.refit());
    this.resizeObs.observe(this.el);

    this.tab = document.createElement("li");
    this.tab.innerHTML = `
      <span class="dot"></span>
      <span class="meta"><span class="name"></span><span class="path"></span></span>
      <kbd></kbd>
      <button class="icon-btn close" title="Close session">${icon("x")}</button>`;
    this.tab.querySelector(".name")!.textContent = basename(opts.cwd);
    this.tab.querySelector(".path")!.textContent = `\u200E${opts.cwd}\u200E`;
    this.tab.title = opts.cwd;
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
    // Ctrl+Shift+C / Ctrl+Shift+V on Linux & Windows.
    if (!isMac && e.ctrlKey && e.shiftKey && e.code === "KeyC") {
      const sel = this.term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
      e.preventDefault();
      return false;
    }
    if (!isMac && e.ctrlKey && e.shiftKey && e.code === "KeyV") {
      void navigator.clipboard.readText().then((t) => t && this.term.paste(t));
      e.preventDefault();
      return false;
    }
    // Let app-level shortcuts bubble instead of going to the pty.
    if (isAppShortcut(e)) return false;
    return true;
  }

  refit() {
    if (this.el.offsetParent === null) return; // hidden
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
    onData.onmessage = (chunk) => {
      this.term.write(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk));
    };
    const onExit = new Channel<{ code: number | null }>();
    onExit.onmessage = ({ code }) => this.exited(code);

    try {
      this.ptyId = await invoke<number>("pty_spawn", {
        cwd: this.opts.cwd,
        args: buildArgs(this.opts),
        binary: settings.binary || null,
        cols: this.term.cols,
        rows: this.term.rows,
        onData,
        onExit,
      });
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

function activate(s: Session) {
  active = s;
  for (const x of sessions) {
    x.el.classList.toggle("active", x === s);
    x.tab.classList.toggle("active", x === s);
  }
  $("#empty").hidden = true;
  updateTopbar();
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

function updateTopbar() {
  const bar = $("#topbar");
  bar.hidden = !active;
  sessions.forEach((x, i) => {
    x.tab.querySelector("kbd")!.textContent = i < 9 ? (isMac ? `⌘${i + 1}` : `${i + 1}`) : "";
  });
  $("#tab-count").textContent = sessions.length ? String(sessions.length) : "";
  if (!active) return;
  const o = active.opts;
  $("#tb-name").textContent = basename(o.cwd);
  $("#tb-path").textContent = o.cwd;
  const chips: [string, boolean][] = [];
  if (o.model) chips.push([o.model[0].toUpperCase() + o.model.slice(1), false]);
  if (o.permissionMode) chips.push([PERM_LABELS[o.permissionMode] ?? o.permissionMode, o.permissionMode === "bypassPermissions"]);
  if (o.continueLast) chips.push(["Continued", false]);
  const row = $("#tb-chips");
  row.innerHTML = "";
  for (const [label, warn] of chips) {
    const c = document.createElement("span");
    c.className = warn ? "chip warn" : "chip";
    c.textContent = label;
    row.appendChild(c);
  }
}

function closeSession(s: Session) {
  if (s.running && !confirm(`End the Claude session in ${basename(s.opts.cwd)}?`)) return;
  const i = sessions.indexOf(s);
  sessions.splice(i, 1);
  s.dispose();
  if (active === s) {
    const next = sessions[Math.min(i, sessions.length - 1)];
    if (next) activate(next);
    else {
      active = null;
      showEmpty();
    }
  }
  updateTopbar();
}

function startSession(opts: LaunchOptions) {
  pushRecent(opts.cwd);
  const s = new Session(opts);
  sessions.push(s);
  activate(s);
  // Wait a frame so the terminal has its real size before spawning.
  requestAnimationFrame(() => void s.start());
}

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

// ---------- dialogs ----------

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
for (const sel of ["#f-model", "#f-perm"]) {
  $(sel).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (b) setSegment(sel, b.dataset.v ?? "");
  });
}

function openNewDialog(prefill?: string) {
  const dlg = $<HTMLDialogElement>("#new-dialog");
  const cwd = $<HTMLInputElement>("#f-cwd");
  cwd.value = prefill ?? recentFolders()[0] ?? "";
  setSegment("#f-model", lastLaunch.model);
  setSegment("#f-perm", lastLaunch.permissionMode);
  $<HTMLInputElement>("#f-continue").checked = lastLaunch.continueLast;
  $<HTMLInputElement>("#f-extra").value = lastLaunch.extra;

  const chips = $("#f-recent");
  chips.innerHTML = "";
  for (const dir of recentFolders()) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = basename(dir);
    b.title = dir;
    b.addEventListener("click", () => (cwd.value = dir));
    chips.appendChild(b);
  }
  dlg.returnValue = "";
  dlg.showModal();
  cwd.select();
}

$("#f-browse").addEventListener("click", async () => {
  const dir = await pickFolder();
  if (dir) $<HTMLInputElement>("#f-cwd").value = dir;
});

$<HTMLDialogElement>("#new-dialog").addEventListener("close", () => {
  const dlg = $<HTMLDialogElement>("#new-dialog");
  if (dlg.returnValue !== "ok") return;
  lastLaunch = {
    model: getSegment("#f-model"),
    permissionMode: getSegment("#f-perm"),
    continueLast: $<HTMLInputElement>("#f-continue").checked,
    extra: $<HTMLInputElement>("#f-extra").value.trim(),
  };
  store.set("lastLaunch", lastLaunch);
  startSession({ ...lastLaunch, cwd: $<HTMLInputElement>("#f-cwd").value.trim() });
});

function openSettings() {
  $<HTMLInputElement>("#s-binary").value = settings.binary;
  $<HTMLInputElement>("#s-font").value = String(settings.fontSize);
  const dlg = $<HTMLDialogElement>("#settings-dialog");
  dlg.returnValue = "";
  dlg.showModal();
}

$<HTMLDialogElement>("#settings-dialog").addEventListener("close", () => {
  if ($<HTMLDialogElement>("#settings-dialog").returnValue !== "ok") return;
  const font = Number($<HTMLInputElement>("#s-font").value);
  settings = {
    binary: $<HTMLInputElement>("#s-binary").value.trim(),
    fontSize: Number.isFinite(font) && font >= 9 && font <= 28 ? font : 13,
  };
  store.set("settings", settings);
  for (const s of sessions) {
    s.term.options.fontSize = settings.fontSize;
    s.refit();
  }
  void checkCli();
});

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
  if (mod && ["KeyT", "KeyW", "Comma"].includes(e.code)) return true;
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
if (isMac) document.body.classList.add("mac");

// Load the bundled fonts up front so xterm measures the real glyphs.
void Promise.all(
  ["400", "600"].map((w) => document.fonts.load(`${w} ${settings.fontSize}px "JetBrains Mono"`)),
).catch(() => {});

showEmpty();
updateTopbar();
void checkCli();

for (const btn of document.querySelectorAll<HTMLButtonElement>("dialog .cancel")) {
  btn.addEventListener("click", () => btn.closest("dialog")!.close("cancel"));
}
