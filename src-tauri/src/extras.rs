//! Helpers the UI needs around a session: past conversations, git branch,
//! and turning a clipboard image into a file Claude Code can read.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

pub(crate) fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))
}

/// Claude Code stores each project's conversations in a folder named after
/// the working directory with every non-alphanumeric character replaced by '-'.
pub(crate) fn project_key(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    id: String,
    title: String,
    prompts: u32,
    modified_ms: u64,
    /// The folder the conversation ran in (from its entries).
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => blocks.iter().find_map(|b| {
            (b.get("type")?.as_str()? == "text").then(|| b.get("text")?.as_str().map(String::from))?
        }),
        _ => None,
    }
}

/// A real typed prompt, as opposed to tool results, slash-command wrappers
/// and other bookkeeping entries.
fn prompt_text(entry: &Value) -> Option<String> {
    if entry.get("type")?.as_str()? != "user" || entry.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let text = text_of(entry.get("message")?.get("content")?)?;
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return None;
    }
    Some(t.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reads a conversation file: its title (custom title, summary, or first prompt), prompt
/// count and folder. With `head`, only the first `head` bytes are read, which is enough
/// for the title and folder and keeps listing every project's history fast (the prompt
/// count is then only for that part).
fn read_conversation(path: &Path, head: Option<u64>) -> Option<Conversation> {
    let id = path.file_stem()?.to_str()?.to_string();
    let modified_ms = modified_ms(path);
    let file = fs::File::open(path).ok()?;
    let reader: Box<dyn BufRead> = match head {
        Some(n) => Box::new(BufReader::new(std::io::Read::take(file, n))),
        None => Box::new(BufReader::new(file)),
    };
    let (mut first, mut summary, mut custom, mut cwd) = (None, None, None, None);
    let mut prompts = 0;
    for line in reader.lines().map_while(Result::ok) {
        // Cheap pre-filter: most lines are large assistant/tool entries.
        if !(line.contains("\"user\"") || line.contains("\"summary\"") || line.contains("custom-title")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(Value::as_str).map(String::from);
        }
        match v.get("type").and_then(Value::as_str) {
            Some("summary") => summary = v.get("summary").and_then(Value::as_str).map(String::from),
            Some("custom-title") => custom = v.get("customTitle").and_then(Value::as_str).map(String::from),
            _ => {
                if let Some(p) = prompt_text(&v) {
                    prompts += 1;
                    first.get_or_insert(p);
                }
            }
        }
    }
    let title = custom.or(summary).or(first)?;
    Some(Conversation { id, title: title.chars().take(160).collect(), prompts, modified_ms, cwd })
}

/// Past conversations for `cwd`, newest first.
#[tauri::command]
pub async fn list_conversations(cwd: String) -> Result<Vec<Conversation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = claude_dir().map(|d| d.join("projects").join(project_key(&cwd))) else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
        // Newest files first by modification time (cheap), then read only as many as
        // are shown: a busy project has hundreds of conversations, some tens of MB each.
        let mut files: Vec<(u64, PathBuf)> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .map(|p| (modified_ms(&p), p))
            .collect();
        files.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
        files.into_iter().filter_map(|(_, p)| read_conversation(&p, None)).take(50).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// The most recent conversations across every project, newest first, each with its
/// folder. Only the start of each file is read (see `read_conversation`).
#[tauri::command]
pub async fn list_all_conversations(limit: Option<usize>) -> Result<Vec<Conversation>, String> {
    let limit = limit.unwrap_or(300).min(2000);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(projects) = claude_dir().map(|d| d.join("projects")) else { return Vec::new() };
        let Ok(dirs) = fs::read_dir(&projects) else { return Vec::new() };
        // Newest files first by modification time (cheap), then read just those.
        let mut files: Vec<(u64, PathBuf)> = dirs
            .filter_map(Result::ok)
            .filter(|d| d.path().is_dir())
            .flat_map(|d| fs::read_dir(d.path()).into_iter().flatten().filter_map(Result::ok))
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .map(|p| (modified_ms(&p), p))
            .collect();
        files.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
        files
            .into_iter()
            .filter_map(|(_, p)| read_conversation(&p, Some(256 * 1024)))
            .take(limit)
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Whether Claude Code has saved conversation `id` for `cwd` (it only writes the
/// file once the first message is sent).
#[tauri::command(async)]
pub fn conversation_exists(cwd: String, id: String) -> bool {
    // Only plain UUID-like ids, so `id` can't point outside the projects folder.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return false;
    }
    claude_dir()
        .map(|d| d.join("projects").join(project_key(&cwd)).join(format!("{id}.jsonl")).is_file())
        .unwrap_or(false)
}

/// Current branch (or short commit when detached) of the repo containing `cwd`.
/// Reads `.git/HEAD` directly, so it's cheap enough to poll.
#[tauri::command(async)]
pub fn git_branch(cwd: String) -> Option<String> {
    let mut dir = PathBuf::from(cwd);
    loop {
        let dotgit = dir.join(".git");
        let git_dir = if dotgit.is_dir() {
            Some(dotgit)
        } else if dotgit.is_file() {
            // Worktrees and submodules: ".git" is a file containing "gitdir: <path>".
            fs::read_to_string(&dotgit).ok().and_then(|s| {
                let p = PathBuf::from(s.trim().strip_prefix("gitdir:")?.trim());
                Some(if p.is_absolute() { p } else { dir.join(p) })
            })
        } else {
            None
        };
        if let Some(g) = git_dir {
            let head = fs::read_to_string(g.join("HEAD")).ok()?;
            let head = head.trim();
            return Some(match head.strip_prefix("ref: refs/heads/") {
                Some(branch) => branch.to_string(),
                None => head.chars().take(7).collect(),
            });
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// One clipboard for the whole run. On Linux (X11/Wayland) the copying app has to keep
/// serving what it copied, which arboard does only while a `Clipboard` exists; a
/// short-lived one would lose the text as soon as it's dropped.
fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, String>) -> Result<T, String> {
    static CLIPBOARD: std::sync::OnceLock<std::sync::Mutex<Option<arboard::Clipboard>>> = std::sync::OnceLock::new();
    let mut slot = CLIPBOARD.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|e| e.to_string())?);
    }
    f(slot.as_mut().unwrap())
}

/// Text on the system clipboard, read natively (the web view's clipboard API can be
/// blocked or ask for permission, notably in WebView2 on Windows).
#[tauri::command]
pub async fn read_clipboard_text() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| with_clipboard(|c| Ok(c.get_text().ok().filter(|t| !t.is_empty()))))
    .await
    .map_err(|e| e.to_string())?
}

/// Puts `text` on the system clipboard.
#[tauri::command]
pub async fn write_clipboard_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_clipboard(|c| c.set_text(text).map_err(|e| e.to_string())))
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the image on the clipboard as a PNG in the temp folder and returns its
/// path, or `None` when the clipboard holds no image.
#[tauri::command]
pub async fn save_clipboard_image() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(img) = with_clipboard(|c| Ok(c.get_image().ok()))? else { return Ok(None) };
        let dir = std::env::temp_dir().join("claude-desk");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
        let path = dir.join(format!("pasted-{stamp}.png"));
        let file = fs::File::create(&path).map_err(|e| e.to_string())?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), img.width as u32, img.height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()
            .and_then(|mut w| w.write_image_data(&img.bytes))
            .map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_key_matches_claude_code() {
        assert_eq!(project_key("/home/user"), "-home-user");
        assert_eq!(project_key("/Users/me/my.app_v2/"), "-Users-me-my-app-v2");
        assert_eq!(project_key(r"C:\code\x"), "C--code-x");
    }

    #[test]
    fn prompt_text_skips_bookkeeping() {
        let real: Value = serde_json::json!({"type":"user","message":{"content":"fix  the\nbug"}});
        let cmd: Value = serde_json::json!({"type":"user","message":{"content":"<command-name>/clear</command-name>"}});
        let tool: Value = serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]}});
        assert_eq!(prompt_text(&real).as_deref(), Some("fix the bug"));
        assert_eq!(prompt_text(&cmd), None);
        assert_eq!(prompt_text(&tool), None);
    }
}

#[cfg(test)]
mod perf {
    //! Timing checks with large synthetic data. Run with:
    //! cargo test --release perf_ -- --ignored --nocapture
    use super::*;
    use std::io::Write;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn perf_history() {
        let root = std::env::temp_dir().join("claude-desk-perf-claude");
        let _ = fs::remove_dir_all(&root);
        // 40 projects x 50 conversations; each ~60 user/assistant entries (~250 KB).
        let big = "x".repeat(4000);
        for p in 0..40 {
            let dir = root.join("projects").join(format!("-work-project-{p}"));
            fs::create_dir_all(&dir).unwrap();
            for c in 0..50 {
                let mut f = fs::File::create(dir.join(format!("{p:04}-{c:04}-conv.jsonl"))).unwrap();
                for i in 0..60 {
                    if i % 2 == 0 {
                        writeln!(f, r#"{{"type":"user","cwd":"/work/project-{p}","message":{{"content":"prompt {i} for task {c}"}}}}"#).unwrap();
                    } else {
                        writeln!(f, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{big}"}}]}}}}"#).unwrap();
                    }
                }
            }
        }
        std::env::set_var("CLAUDE_CONFIG_DIR", &root);
        let total: u64 = fs::read_dir(root.join("projects")).unwrap()
            .flat_map(|d| fs::read_dir(d.unwrap().path()).unwrap())
            .map(|e| e.unwrap().metadata().unwrap().len()).sum();
        println!("history: 2000 conversations, {} MB", total / 1_000_000);

        let t = Instant::now();
        let all = tauri::async_runtime::block_on(list_all_conversations(Some(400))).unwrap();
        println!("list_all_conversations(400): {} results in {:?}", all.len(), t.elapsed());
        let t = Instant::now();
        let one = tauri::async_runtime::block_on(list_conversations("/work/project-7".into())).unwrap();
        println!("list_conversations(one folder, 50 files): {} results in {:?}", one.len(), t.elapsed());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore]
    fn perf_busy_project() {
        // One busy project: 300 conversations of ~1.5 MB (long sessions with big tool output).
        let root = std::env::temp_dir().join("claude-desk-perf-busy");
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("projects").join("-work-busy");
        fs::create_dir_all(&dir).unwrap();
        let big = "y".repeat(6000);
        for c in 0..300 {
            let mut f = fs::File::create(dir.join(format!("{c:04}-conv.jsonl"))).unwrap();
            for i in 0..250 {
                if i % 2 == 0 {
                    writeln!(f, r#"{{"type":"user","cwd":"/work/busy","message":{{"content":[{{"type":"tool_result","content":"{big}"}}]}}}}"#).unwrap();
                } else {
                    writeln!(f, r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{big}"}}]}}}}"#).unwrap();
                }
            }
            writeln!(f, r#"{{"type":"user","cwd":"/work/busy","message":{{"content":"prompt for task {c}"}}}}"#).unwrap();
        }
        std::env::set_var("CLAUDE_CONFIG_DIR", &root);
        let one = tauri::async_runtime::block_on(list_conversations("/work/busy".into())).unwrap(); // warm cache
        let t = Instant::now();
        let one2 = tauri::async_runtime::block_on(list_conversations("/work/busy".into())).unwrap();
        println!("list_conversations(busy folder, 300 files, ~450 MB): {} results in {:?}", one2.len(), t.elapsed());
        assert_eq!(one.len(), 50);
        let _ = fs::remove_dir_all(&root);
    }
}
