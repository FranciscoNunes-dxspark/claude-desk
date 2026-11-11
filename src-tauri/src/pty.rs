//! Runs the `claude` CLI inside a pseudo-terminal and streams its output to the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
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
    master: Box<dyn MasterPty + Send>,
    /// Input for the session's writer thread. Writing to a pty blocks while the program
    /// isn't reading, so it never happens on the command (main) thread or under `sessions`.
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
                let _ = s.killer.kill();
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitInfo {
    code: Option<u32>,
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

    let (program, argv) = launch_spec(binary.as_deref(), &args);
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&argv);
    cmd.cwd(&cwd);
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "ClaudeDesk");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("failed to start `{program}`: {e}"))?;
    // Drop our copy of the slave so reads hit EOF once the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let input = spawn_writer(pair.master.take_writer().map_err(|e| e.to_string())?);
    let killer = child.clone_killer();
    let flow = Arc::new(Flow::default());

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { flow: flow.clone(), master: pair.master, input, killer });

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

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        s.killer.kill().map_err(|e| e.to_string())?;
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
