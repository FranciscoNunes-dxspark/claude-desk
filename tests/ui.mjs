// UI robustness tests: the real app in headless Chromium, with the Tauri backend
// replaced by a scripted fake (spawned "Claude" processes, their output and exits,
// dialogs). Each scenario is a way a session used to freeze, go deaf to input, or
// end up in a wrong state.
//
//   npm run test:ui
//
// Needs Playwright's Chromium (`npx playwright install chromium` once).
import { createServer } from "vite";
import { chromium } from "playwright";

/** Runs in the page before the app: the fake backend. */
function fakeBackend() {
  const cbs = {};
  let nextCb = 1;
  let nextPty = 0;
  window.__calls = [];
  window.__ch = {};
  window.__listeners = {};
  window.__opt = { spawnDelay: 0, writeFails: false, dialogAnswer: "End session" };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: (cb) => {
      const id = nextCb++;
      cbs[id] = cb;
      return id;
    },
    unregisterCallback: (id) => delete cbs[id],
    convertFileSrc: (x) => x,
    invoke: async (cmd, args) => {
      const call = [cmd, args?.id ?? null, cmd === "pty_write" ? args.data : (args?.bytes ?? null)];
      if (/^pty_(spawn|write|kill|ack)$/.test(cmd) || cmd === "plugin:dialog|message") window.__calls.push(call);
      if (cmd === "pty_spawn") {
        await new Promise((r) => setTimeout(r, window.__opt.spawnDelay));
        const id = ++nextPty;
        window.__ch[id] = { data: cbs[args.onData.id ?? args.onData], exit: cbs[args.onExit.id ?? args.onExit], i: 0 };
        call.push(id);
        return id;
      }
      if (cmd === "plugin:event|listen") {
        (window.__listeners[args.event] ??= []).push(args.handler);
        return nextCb++;
      }
      if (cmd === "pty_write" && window.__opt.writeFails) throw "session not found";
      if (cmd === "plugin:dialog|message") return window.__opt.dialogAnswer;
      if (cmd === "claude_version") return "2.0.0 (Claude Code)";
      if (cmd === "git_changes") return window.__git ?? { branch: "main", files: [], upstream: null, ahead: 0, hasRemote: false };
      if (cmd === "git_diff") return "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n";
      if (cmd === "git_commit" || cmd === "git_push") {
        window.__calls.push([cmd, args.message ?? null]);
        if (cmd === "git_commit") window.__git = { ...window.__git, files: [], ahead: window.__git.ahead + 1 };
        if (cmd === "git_push") window.__git = { ...window.__git, ahead: 0, upstream: "origin/main" };
        return cmd === "git_commit" ? "abc1234 Fix it" : "";
      }
      if (cmd === "conversation_activity") return { docs: window.__docs?.[args.id] ?? [], todos: window.__todos?.[args.id] ?? [] };
      if (cmd === "read_document") {
        const text = window.__docText?.[args.path];
        if (text == null) throw "The file no longer exists.";
        return { text, modified: text.length };
      }
      return null;
    },
  };
  // The tauri-plugin-dialog init script makes window.confirm async like this.
  window.confirm = async (m) => (await window.__TAURI_INTERNALS__.invoke("plugin:dialog|message", { message: String(m) })) === "Ok";
  window.__send = (id, text) => {
    const c = window.__ch[id];
    c.data({ index: c.i++, message: Array.from(new TextEncoder().encode(text)) });
  };
  window.__exit = (id, code = 0) => window.__ch[id].exit({ index: 0, message: { code } });
  // A drag from the OS, as Tauri reports it: positions in physical pixels.
  window.__drag = (kind, x, y, paths = ["/tmp/report.pdf"]) => {
    const r = devicePixelRatio;
    for (const h of window.__listeners[`tauri://drag-${kind}`] ?? []) {
      cbs[h]({ event: `tauri://drag-${kind}`, id: 0, payload: { paths, position: { x: x * r, y: y * r } } });
    }
  };
  window.__count = (cmd) => window.__calls.filter((c) => c[0] === cmd).length;
  window.__acked = (id) => window.__calls.filter((c) => c[0] === "pty_ack" && (id == null || c[1] === id)).reduce((a, c) => a + c[2], 0);
  const sessions = (window.__sessions ?? ["a"]).map((x) => ({ cwd: `/w/${x}`, conversationId: x, model: "", permissionMode: "", conversation: "new", extra: "" }));
  localStorage.setItem("workspace", JSON.stringify({ active: 0, sessions }));
}

const tabs = (p) => p.evaluate(() => document.querySelectorAll("#tabs li").length);
const endFirstRun = async (p) => {
  await p.evaluate(() => window.__exit(1, 0));
  await p.waitForTimeout(200);
};

/** name → [sessions to open, scenario]; a scenario returns [passed, detail]. */
const scenarios = {
  "pressing Enter twice on an ended session starts one Claude": [1, async (p) => {
    await endFirstRun(p);
    await p.evaluate(() => { window.__opt.spawnDelay = 200; window.__calls = []; });
    await p.click(".xterm");
    await p.keyboard.press("Enter");
    await p.keyboard.press("Enter");
    await p.waitForTimeout(600);
    const n = await p.evaluate(() => window.__count("pty_spawn"));
    return [n === 1, `${n} started`];
  }],
  "closing while Claude starts doesn't leave it running": [1, async (p) => {
    await endFirstRun(p);
    await p.evaluate(() => { window.__opt.spawnDelay = 300; window.__calls = []; });
    await p.click(".banner .btn.primary");
    await p.waitForTimeout(50);
    await p.click('.term.active [data-act="close"]');
    await p.waitForTimeout(600);
    const calls = await p.evaluate(() => window.__calls);
    const spawned = calls.find((c) => c[0] === "pty_spawn")?.[3];
    const killed = calls.some((c) => c[0] === "pty_kill" && c[1] === spawned);
    return [killed, killed ? "stopped" : "left running"];
  }],
  "a lost process shows as ended instead of ignoring input": [1, async (p) => {
    await p.evaluate(() => { window.__opt.writeFails = true; });
    await p.click(".xterm");
    await p.keyboard.type("hello");
    await p.waitForTimeout(2000);
    const banner = await p.evaluate(() => !!document.querySelector(".banner"));
    return [banner, banner ? 'shows "Session ended"' : "still looks alive"];
  }],
  "an old run's late exit doesn't end the new run": [1, async (p) => {
    await p.evaluate(() => { window.__opt.writeFails = true; });
    await p.click(".xterm");
    await p.keyboard.type("x");
    await p.waitForTimeout(2000);
    await p.evaluate(() => { window.__opt.writeFails = false; });
    await p.click(".banner .btn.primary");
    await p.waitForTimeout(300);
    await p.evaluate(() => window.__exit(1, 1));
    await p.waitForTimeout(200);
    const banner = await p.evaluate(() => !!document.querySelector(".banner"));
    return [!banner, banner ? "new run shown as ended" : "new run unaffected"];
  }],
  "keys typed while Claude starts are delivered": [1, async (p) => {
    await endFirstRun(p);
    await p.evaluate(() => { window.__opt.spawnDelay = 400; window.__calls = []; });
    await p.click(".banner .btn.primary");
    await p.click(".xterm");
    await p.keyboard.type("hi");
    await p.waitForTimeout(700);
    const sent = await p.evaluate(() => window.__calls.filter((c) => c[0] === "pty_write").map((c) => c[2]).join(""));
    return [sent.includes("hi"), sent ? `sent ${JSON.stringify(sent)}` : "dropped"];
  }],
  "all output is acknowledged once it pauses": [1, async (p) => {
    await p.evaluate(() => { window.__calls = []; window.__send(1, "x".repeat(10000)); });
    await p.waitForTimeout(600);
    const acked = await p.evaluate(() => window.__acked(1));
    return [acked === 10000, `${acked} of 10000 bytes acknowledged`];
  }],
  "a minimised window acknowledges output on arrival": [1, async (p) => {
    await p.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); window.__calls = []; });
    // Send and count before xterm's timers run, as throttled timers would delay them.
    const acked = await p.evaluate(() => {
      for (let i = 0; i < 70; i++) window.__send(1, "y".repeat(1024));
      return window.__acked(1);
    });
    return [acked >= 65536, `${acked} bytes acknowledged before processing`];
  }],
  "a failing terminal handler doesn't freeze the session": [2, async (p) => {
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.evaluate(() => {
      window.__send(2, "hello ");
      delete window.__TAURI_INTERNALS__.metadata; // the bell handler now throws
      window.__send(2, "\x07world\r\n");
      for (let i = 0; i < 80; i++) window.__send(2, "x".repeat(1000) + "\r\n");
    });
    await p.waitForTimeout(1500);
    const acked = await p.evaluate(() => window.__acked(2));
    return [acked > 80000 && errors.length === 0, `${acked} bytes processed after the bell, ${errors.length} page errors`];
  }],
  "a dropped file goes to the session under the pointer": [3, async (p) => {
    await p.evaluate(() => document.querySelector('#layout-switch [data-layout="columns"]').click());
    await p.waitForTimeout(400);
    const centre = (sel) => p.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, sel);
    const [x3, y3] = await centre(".term:nth-of-type(3)");
    await p.evaluate(([x, y]) => { window.__calls = []; window.__drag("enter", x, y); window.__drag("over", x, y); }, [x3, y3]);
    const hint = await p.evaluate(() => ({ text: document.querySelector("#drop-hint").textContent, shown: !document.querySelector("#drop-hint").hidden }));
    await p.evaluate(([x, y]) => window.__drag("drop", x, y), [x3, y3]);
    await p.waitForTimeout(100);
    // Then onto the first session's tab in the sidebar.
    const [xt, yt] = await centre("#tabs li:nth-child(1)");
    await p.evaluate(([x, y]) => { window.__drag("enter", x, y); window.__drag("drop", x, y, ["/tmp/a b.txt"]); }, [xt, yt]);
    await p.waitForTimeout(100);
    const writes = await p.evaluate(() => window.__calls.filter((c) => c[0] === "pty_write").map((c) => [c[1], c[2]]));
    const ok = hint.shown && hint.text.includes("“c”") && writes[0]?.[0] === 3 && writes[0]?.[1].includes("/tmp/report.pdf")
      && writes[1]?.[0] === 1 && writes[1]?.[1].includes("'/tmp/a b.txt'");
    return [ok, `hint ${JSON.stringify(hint.text)}; writes ${JSON.stringify(writes)}`];
  }],
  "keyboard focus returns to the terminal after a dialog": [1, async (p) => {
    await p.click("#palette-btn");
    await p.keyboard.press("Escape");
    await p.click("#settings-btn");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    const [ok, tag] = await p.evaluate(() => [!!document.activeElement?.classList.contains("xterm-helper-textarea"), document.activeElement?.tagName]);
    return [ok, ok ? "terminal focused" : `focus on ${tag}`];
  }],
  "Cancel keeps a running session open": [3, async (p) => {
    await p.evaluate(() => { window.__opt.dialogAnswer = "Cancel"; });
    await p.hover("#tabs li:nth-child(1)");
    await p.click("#tabs li:nth-child(1) .close");
    await p.waitForTimeout(500);
    const n = await tabs(p);
    return [n === 3, `${n} of 3 sessions open`];
  }],
  "closing asks once, even on a double click": [3, async (p) => {
    await p.evaluate(() => { window.__calls = []; const x = document.querySelector('.term.active [data-act="close"]'); x.click(); x.click(); });
    await p.waitForTimeout(500);
    const [n, asked] = [await tabs(p), await p.evaluate(() => window.__count("plugin:dialog|message"))];
    return [n === 2 && asked === 1, `${n} sessions left, asked ${asked}x`];
  }],
  "the close button keeps working after search": [3, async (p) => {
    await p.click("#tb-search");
    await p.keyboard.press("Escape");
    await p.click('.term.active [data-act="close"]');
    await p.waitForTimeout(400);
    await p.click('.term.active [data-act="close"]');
    await p.waitForTimeout(400);
    const n = await tabs(p);
    return [n === 1, `${n} sessions left of 3 after two closes`];
  }],
  "the documents panel shows a session's plan, safely": [2, async (p) => {
    await p.evaluate(() => {
      const doc = (kind, path, at, extra = {}) => ({ kind, path, url: null, title: null, description: null, text: null, at, writes: 1, ...extra });
      window.__docText = { "/w/a/NOTES.md": "# Notes\n\n- one <img src=x onerror=\"window.__xss=1\">" };
      window.__docs = { a: [
        doc("plan", null, "2026-11-13T10:05:00Z", { text: "# The plan\n\n1. Read the code\n2. Fix it" }),
        doc("markdown", "/w/a/NOTES.md", "2026-11-13T10:00:00Z"),
      ] };
    });
    await p.waitForTimeout(2300); // one poll
    await p.click("#tb-docs");
    await p.waitForTimeout(300);
    const plan = await p.evaluate(() => ({ items: document.querySelectorAll("#dc-list li").length, h1: document.querySelector("#dc-body h1")?.textContent }));
    await p.click("#dc-list li:nth-child(2)");
    await p.waitForTimeout(300);
    const notes = await p.evaluate(() => ({ li: document.querySelector("#dc-body li")?.textContent.trim(), xss: window.__xss ?? 0 }));
    const ok = plan.items === 2 && plan.h1 === "The plan" && notes.li === "one" && notes.xss === 0;
    return [ok, `${plan.items} listed, plan "${plan.h1}", notes "${notes.li}", script ran: ${notes.xss}`];
  }],
  "a new document in another session badges its tab": [2, async (p) => {
    await p.click("#tb-docs");
    await p.evaluate(() => { window.__docs = { b: [] }; });
    await p.waitForTimeout(2300); // b's conversation read once: nothing new yet
    const before = await p.evaluate(() => !document.querySelector("#tabs li:nth-child(2) .doc-badge").hidden);
    await p.evaluate(() => {
      window.__docs.b = [{ kind: "plan", path: null, url: null, title: null, description: null, text: "# B", at: "2026-11-13T11:00:00Z", writes: 1 }];
    });
    await p.waitForTimeout(2300);
    const after = await p.evaluate(() => !document.querySelector("#tabs li:nth-child(2) .doc-badge").hidden);
    await p.click("#tabs li:nth-child(2)");
    await p.waitForTimeout(300);
    const seen = await p.evaluate(() => document.querySelector("#tabs li:nth-child(2) .doc-badge").hidden && document.querySelector("#dc-body h1")?.textContent === "B");
    return [!before && after && seen, `before ${before}, after ${after}, cleared and shown ${seen}`];
  }],
  "the to-do list shows progress and the current step": [1, async (p) => {
    await p.evaluate(() => {
      window.__todos = { a: [
        { id: "1", subject: "Read the code", status: "completed", activeForm: "Reading the code" },
        { id: "2", subject: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
        { id: "3", subject: "Run tests", status: "pending", activeForm: null },
      ] };
    });
    await p.waitForTimeout(2300);
    const tab = await p.evaluate(() => document.querySelector("#tabs li .todo-count").textContent);
    const chip = await p.evaluate(() => document.querySelector(".term.active .todo-chip").textContent);
    await p.click(".term.active .todo-chip");
    const items = await p.evaluate(() => [...document.querySelectorAll("#todo-pop li")].map((li) => `${li.dataset.status}:${li.textContent}`));
    await p.keyboard.press("Escape");
    const closed = await p.evaluate(() => document.querySelector("#todo-pop").hidden);
    const ok = tab === "1/3" && chip === "1/3Fixing the bug" && items.length === 3 && items[1] === "in_progress:Fixing the bug" && closed;
    return [ok, `tab "${tab}", chip "${chip}", ${items.join(" | ")}, closes ${closed}`];
  }],
  "a comment on a diff line goes to Claude with its place": [1, async (p) => {
    await p.evaluate(() => {
      window.__git = { branch: "main", files: [{ path: "src/a.ts", status: " M", added: 1, removed: 1, binary: false }], upstream: "origin/main", ahead: 0, hasRemote: true };
    });
    await p.click("#tb-changes");
    await p.waitForTimeout(300);
    await p.click("#ch-files li");
    await p.waitForTimeout(300);
    await p.hover('#ch-diff div[data-ln="2"]');
    await p.click('#ch-diff div[data-ln="2"] .cmt-add');
    await p.keyboard.type("Name it two");
    await p.keyboard.press("Control+Enter");
    const saved = await p.evaluate(() => ({ n: document.querySelectorAll(".cmt-saved").length, bar: document.querySelector("#ch-review-count").textContent }));
    await p.evaluate(() => { window.__calls = []; });
    await p.click("#ch-review-send");
    await p.waitForTimeout(400);
    const sent = await p.evaluate(() => window.__calls.filter((c) => c[0] === "pty_write").map((c) => c[2]).join(""));
    const ok = saved.n === 1 && sent.includes("src/a.ts:2") && sent.includes("> 2") && sent.includes("Name it two") && sent.endsWith("\r");
    return [ok, `${saved.n} saved ("${saved.bar}"), sent ${JSON.stringify(sent.slice(0, 120))}`];
  }],
  "commit and push from the changes panel": [1, async (p) => {
    await p.evaluate(() => {
      window.__git = { branch: "main", files: [{ path: "src/a.ts", status: " M", added: 1, removed: 1, binary: false }], upstream: "origin/main", ahead: 1, hasRemote: true };
    });
    await p.click("#tb-changes");
    await p.waitForTimeout(300);
    const pushLabel = await p.evaluate(() => document.querySelector("#ch-push").textContent);
    await p.click("#ch-commit");
    await p.fill("#cm-text", "Fix it");
    await p.check("#cm-push", { force: true });
    await p.evaluate(() => { window.__calls = []; });
    await p.focus("#cm-text");
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(500);
    const calls = await p.evaluate(() => window.__calls.filter((c) => c[0].startsWith("git_")).map((c) => c.join(":")));
    const after = await p.evaluate(() => ({ msg: document.querySelector("#ch-msg").textContent, push: document.querySelector("#ch-push").hidden, commit: document.querySelector("#ch-commit").disabled }));
    const ok = pushLabel === "Push ↑1" && calls.join(",") === "git_commit:Fix it,git_push:" && after.push && after.commit;
    return [ok, `push showed "${pushLabel}", ran ${calls.join(", ")}, then "${after.msg}", push hidden ${after.push}, commit disabled ${after.commit}`];
  }],
};

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
let failed = 0;
for (const [name, [count, run]] of Object.entries(scenarios)) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.addInitScript(`window.__sessions = ${JSON.stringify(["a", "b", "c"].slice(0, count))}; (${fakeBackend})();`);
  await page.goto(url);
  await page.waitForTimeout(1200);
  let result;
  try {
    result = await run(page);
  } catch (err) {
    result = [false, `error: ${String(err.message).split("\n")[0]}`];
  }
  if (!result[0]) failed++;
  console.log(`${result[0] ? "PASS" : "FAIL"}  ${name}  (${result[1]})`);
  await page.close();
}
await browser.close();
await server.close();
console.log(failed ? `\n${failed} failed` : `\nall ${Object.keys(scenarios).length} passed`);
process.exit(failed ? 1 : 0);
