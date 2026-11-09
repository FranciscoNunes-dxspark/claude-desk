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

fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|h| h.join(".claude")))
}

/// Claude Code stores each project's conversations in a folder named after
/// the working directory with every non-alphanumeric character replaced by '-'.
fn project_key(cwd: &str) -> String {
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

fn read_conversation(path: &Path) -> Option<Conversation> {
    let id = path.file_stem()?.to_str()?.to_string();
    let modified_ms = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let file = fs::File::open(path).ok()?;
    let (mut first, mut summary, mut custom) = (None, None, None);
    let mut prompts = 0;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        // Cheap pre-filter: most lines are large assistant/tool entries.
        if !(line.contains("\"user\"") || line.contains("\"summary\"") || line.contains("custom-title")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
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
    Some(Conversation { id, title: title.chars().take(160).collect(), prompts, modified_ms })
}

/// Past conversations for `cwd`, newest first.
#[tauri::command]
pub async fn list_conversations(cwd: String) -> Result<Vec<Conversation>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(dir) = claude_dir().map(|d| d.join("projects").join(project_key(&cwd))) else {
            return Vec::new();
        };
        let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
        let mut list: Vec<Conversation> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .filter_map(|p| read_conversation(&p))
            .collect();
        list.sort_by_key(|c| std::cmp::Reverse(c.modified_ms));
        list.truncate(50);
        list
    })
    .await
    .map_err(|e| e.to_string())
}

/// Whether Claude Code has saved conversation `id` for `cwd` (it only writes the
/// file once the first message is sent).
#[tauri::command]
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
#[tauri::command]
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

/// Saves the image on the clipboard as a PNG in the temp folder and returns its
/// path, or `None` when the clipboard holds no image.
#[tauri::command]
pub async fn save_clipboard_image() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        let Ok(img) = clipboard.get_image() else { return Ok(None) };
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
