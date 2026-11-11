//! Runs the `claude` CLI inside a pseudo-terminal and streams its output to the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};

/// Backpressure: the reader stops once this many bytes are sent but not yet
/// acknowledged by the webview. Output then waits in the kernel's pty buffer
/// and the program blocks, like in a regular terminal.
const MAX_UNACKED: u64 = 1 << 20;

#[derive(Default)]
struct FlowState {
    unacked: u64,
    closed: bool,
}

#[derive(Default)]
struct Flow {
    state: Mutex<FlowState>,
    cv: Condvar,
}

impl Flow {
    /// Blocks while the webview is too far behind, then records `n` sent bytes.
    fn before_send(&self, n: usize) {
        let mut st = self.state.lock().unwrap();
        while st.unacked > MAX_UNACKED && !st.closed {
            st = self.cv.wait(st).unwrap();
        }
        st.unacked += n as u64;
    }
    fn ack(&self, n: u64) {
        let mut st = self.state.lock().unwrap();
        st.unacked = st.unacked.saturating_sub(n);
        self.cv.notify_all();
    }
    fn close(&self) {
        self.state.lock().unwrap().closed = true;
        self.cv.notify_all();
    }
}

struct Session {
    flow: Arc<Flow>,
    /// Where Claude Code's status line input is saved (see `status_settings`).
    status: Option<PathBuf>,
    master: Box<dyn MasterPty + Send>,
    /// Input for the session's writer thread. Writing to a pty blocks while the program
    /// isn't reading, so it never happens on the command (main) thread or under `sessions`.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

impl Session {
    /// Ends the program and everything it started. On Windows Claude runs under
    /// `cmd.exe /C`, and terminating cmd.exe alone would leave Claude running.
    fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if let Some(pid) = self.pid {
                // Not waited for: this runs on the main thread.
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
        }
        #[cfg(not(windows))]
        let _ = self.pid;
        self.killer.kill()
    }
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

impl Drop for PtyState {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for (_, mut s) in sessions.drain() {
                let _ = s.kill();
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    code: Option<u32>,
}

/// The status line Claude Code would use without us: the last of user, project and
/// local settings that sets one (managed settings override ours anyway).
fn own_status_line(cwd: &Path) -> Option<serde_json::Value> {
    let files = [
        crate::extras::claude_dir().map(|d| d.join("settings.json")),
        Some(cwd.join(".claude").join("settings.json")),
        Some(cwd.join(".claude").join("settings.local.json")),
    ];
    files
        .into_iter()
        .flatten()
        .filter_map(|f| std::fs::read_to_string(f).ok())
        .filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter_map(|v| v.get("statusLine").cloned())
        .next_back()
}

/// Claude Code hands its status line command its live state as JSON: the conversation
/// id (it changes on /clear and /resume), the model, the context window and how full
/// it is, and the plan's usage limits. We give it a status line that saves that JSON
/// to `status_file` (named in $CLAUDE_DESK_STATUS) and then runs the user's own status
/// line, if any, on the same input, so theirs keeps working. Returns the settings file
/// to pass with `--settings`.
fn status_settings(cwd: &Path, dir: &Path, id: u32) -> Option<PathBuf> {
    let own = own_status_line(cwd);
    let own_cmd = own.as_ref().and_then(|v| v.get("command")).and_then(|c| c.as_str()).filter(|c| !c.trim().is_empty());
    let command = match own_cmd {
        Some(c) => format!("tee \"$CLAUDE_DESK_STATUS\" | ( {c}\n)"),
        None => "cat > \"$CLAUDE_DESK_STATUS\"".to_string(),
    };
    let mut line = serde_json::json!({ "type": "command", "command": command });
    for key in ["padding", "refreshInterval"] {
        if let Some(v) = own.as_ref().and_then(|o| o.get(key)) {
            line[key] = v.clone();
        }
    }
    let path = dir.join(format!("settings-{}-{id}.json", std::process::id()));
    std::fs::write(&path, serde_json::json!({ "statusLine": line }).to_string()).ok()?;
    Some(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

/// GUI apps (especially on macOS) start with a minimal PATH. Prepend the places
/// Claude Code is usually installed so `claude` resolves without shell config.
fn augmented_path() -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts: Vec<String> = Vec::new();
    if let Some(home) = home_dir() {
        for rel in [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin"] {
            parts.push(home.join(rel).to_string_lossy().into_owned());
        }
        if cfg!(windows) {
            parts.push(home.join("AppData\\Roaming\\npm").to_string_lossy().into_owned());
        }
    }
    if !cfg!(windows) {
        parts.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(String::from));
    }
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(sep)
}

/// Returns (program, argv) that launches claude with `args`.
/// With an explicit binary we exec it directly. Otherwise we go through the
/// user's login shell so their PATH (nvm, asdf, ...) is honoured.
fn launch_spec(binary: Option<&str>, args: &[String]) -> (String, Vec<String>) {
    if let Some(bin) = binary.filter(|b| !b.trim().is_empty()) {
        return (bin.trim().to_string(), args.to_vec());
    }
    if cfg!(windows) {
        let mut argv = vec!["/C".to_string(), "claude".to_string()];
        argv.extend_from_slice(args);
        return ("cmd.exe".to_string(), argv);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }
    });
    // Positional parameters avoid any quoting problems with user-supplied args.
    let mut argv = vec![
        "-l".to_string(),
        "-c".to_string(),
        "exec claude \"$@\"".to_string(),
        "claude".to_string(),
    ];
    argv.extend_from_slice(args);
    (shell, argv)
}

/// Starts a thread that writes what it's sent to the pty, in order. It ends when the
/// sender is dropped (the session is removed) or the pty is gone.
fn spawn_writer(mut writer: Box<dyn Write + Send>) -> mpsc::Sender<Vec<u8>> {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in rx {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: String,
    args: Vec<String>,
    binary: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<ExitInfo>,
) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    // Claude Code's live status, unless the user passes settings of their own.
    let dir = std::env::temp_dir().join("claude-desk");
    let status_file = dir.join(format!("status-{}-{id}.json", std::process::id()));
    let settings_file = (!args.iter().any(|a| a == "--settings"))
        .then(|| std::fs::create_dir_all(&dir).ok())
        .flatten()
        .and_then(|_| status_settings(Path::new(&cwd), &dir, id));
    let mut args = args;
    if let Some(f) = &settings_file {
        args.splice(0..0, ["--settings".to_string(), f.to_string_lossy().into_owned()]);
    }

    let (program, argv) = launch_spec(binary.as_deref(), &args);
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&argv);
    cmd.cwd(&cwd);
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "ClaudeDesk");
    cmd.env("CLAUDE_DESK_STATUS", &status_file);

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to start `{program}`: {e}"))?;
    // Drop our copy of the slave so reads hit EOF once the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let input = spawn_writer(pair.master.take_writer().map_err(|e| e.to_string())?);
    let killer = child.clone_killer();
    let pid = child.process_id();
    let flow = Arc::new(Flow::default());

    let status = settings_file.as_ref().map(|_| status_file.clone());
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { flow: flow.clone(), status, master: pair.master, input, killer, pid });

    // Reader: forward raw bytes (xterm.js handles UTF-8 split across chunks).
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let reader_flow = flow.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    reader_flow.before_send(n);
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = done_tx.send(());
    });

    // Waiter: report exit once the process ends and output has drained.
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // Never leave the reader parked waiting for acks after exit.
        flow.close();
        // Dropping the master unblocks the reader on Windows (ConPTY).
        let session = app.state::<PtyState>().sessions.lock().unwrap().remove(&id);
        drop(session);
        let _ = done_rx.recv_timeout(Duration::from_millis(1000));
        let _ = on_exit.send(ExitInfo { code });
        if let Some(f) = settings_file {
            let _ = std::fs::remove_file(f);
            let _ = std::fs::remove_file(status_file);
        }
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("session not found")?;
    s.input.send(data.into_bytes()).map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("session not found")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_ack(state: State<'_, PtyState>, id: u32, bytes: u64) {
    if let Some(s) = state.sessions.lock().unwrap().get(&id) {
        s.flow.ack(bytes);
    }
}

/// Claude Code's latest status line input for session `id` (see `status_settings`),
/// or `None` before it has reported (or when it can't, e.g. managed settings).
#[tauri::command]
pub async fn pty_status(state: State<'_, PtyState>, id: u32) -> Result<Option<serde_json::Value>, String> {
    let Some(path) = state.sessions.lock().unwrap().get(&id).and_then(|s| s.status.clone()) else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || {
        // A half-written file (Claude is writing it right now) is skipped until next time.
        std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        s.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Runs `claude --version` so the UI can tell whether the CLI is reachable.
#[tauri::command]
pub async fn claude_version(binary: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (program, argv) = launch_spec(binary.as_deref(), &["--version".to_string()]);
        let mut cmd = std::process::Command::new(&program);
        cmd.args(&argv).env("PATH", augmented_path());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = cmd.output().map_err(|e| format!("failed to run `{program}`: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if err.is_empty() { "claude not found".into() } else { err })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Runs the status line command from `settings` the way Claude Code does: through
    /// the shell, with the status JSON on stdin. Returns what it printed.
    fn run_status_line(settings: &Path, status_file: &Path, input: &str) -> String {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(settings).unwrap()).unwrap();
        let cmd = v["statusLine"]["command"].as_str().unwrap();
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .env("CLAUDE_DESK_STATUS", status_file)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        String::from_utf8(child.wait_with_output().unwrap().stdout).unwrap()
    }

    #[test]
    fn status_line_saves_claudes_status_and_keeps_the_users_own() {
        let root = std::env::temp_dir().join(format!("claude-desk-status-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (proj, dir) = (root.join("proj"), root.join("out"));
        std::fs::create_dir_all(proj.join(".claude")).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let input = r#"{"session_id":"abc","context_window":{"context_window_size":1000000}}"#;

        // No status line of the user's: just save the input.
        let status = dir.join("s1.json");
        let settings = status_settings(&proj, &dir, 1).unwrap();
        assert_eq!(run_status_line(&settings, &status, input), "");
        assert_eq!(std::fs::read_to_string(&status).unwrap(), input);

        // The project's own status line still runs and gets the same input.
        std::fs::write(
            proj.join(".claude/settings.local.json"),
            r#"{"statusLine":{"type":"command","command":"printf 'mine:'; wc -c # comment","padding":2}}"#,
        )
        .unwrap();
        let status = dir.join("s2.json");
        let settings = status_settings(&proj, &dir, 2).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["statusLine"]["padding"], 2);
        let out = run_status_line(&settings, &status, input);
        assert_eq!(out.split_whitespace().collect::<String>(), format!("mine:{}", input.len()));
        assert_eq!(std::fs::read_to_string(&status).unwrap(), input);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A program that isn't reading its input (here `sleep`) fills the pty's buffer and a
    /// direct write blocks. Sending input must still return at once: `pty_write` runs on
    /// the main thread, so blocking there would freeze the whole window.
    #[test]
    fn input_never_blocks_the_caller() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut child = pair.slave.spawn_command({
            let mut c = CommandBuilder::new("sleep");
            c.arg("3");
            c
        }).unwrap();
        let input = spawn_writer(pair.master.take_writer().unwrap());
        let t = Instant::now();
        for _ in 0..64 {
            input.send(vec![b'x'; 16 * 1024]).unwrap(); // 1 MB, far more than a pty buffers
        }
        assert!(t.elapsed() < Duration::from_millis(200), "sending input blocked for {:?}", t.elapsed());
        let _ = child.kill();
    }
}
