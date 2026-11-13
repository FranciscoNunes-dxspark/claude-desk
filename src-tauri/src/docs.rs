//! The documents a session's conversation produced: markdown files Claude wrote or
//! edited, its plans, and the artifacts it published on claude.ai. Read from the file
//! Claude Code writes (`~/.claude/projects/<folder>/<id>.jsonl`), like `usage`, and only
//! what was appended since the last call.
//!
//! The web view can read a document's text (`read_document`) or preview an artifact
//! (the `swpreview` scheme) only for files a conversation named this way, so neither
//! can be used to read arbitrary files.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

use crate::extras::{claude_dir, project_key};

/// Larger files aren't shown; a document this size is almost certainly not prose.
const MAX_READ: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Doc {
    /// "plan", "markdown" or "artifact".
    pub kind: &'static str,
    /// The file on disk (an artifact's source page), if there is one.
    pub path: Option<String>,
    /// An artifact's claude.ai link.
    pub url: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// A plan Claude presented without a file (older Claude Code versions).
    pub text: Option<String>,
    /// When it was last written or published (the conversation's timestamp).
    pub at: Option<String>,
    /// How many times the conversation wrote or published it.
    pub writes: u32,
}

#[derive(Default)]
struct Tracked {
    offset: u64,
    /// Most recently written last.
    docs: Vec<Doc>,
    /// Tool calls whose result is still to come: they count once they succeed.
    pending: HashMap<String, Doc>,
}

fn known() -> &'static Mutex<HashSet<PathBuf>> {
    static KNOWN: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    KNOWN.get_or_init(Default::default)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_markdown(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".md", ".markdown", ".mdx"].iter().any(|e| lower.ends_with(e))
}

fn is_plan_file(path: &str) -> bool {
    let p = path.replace('\\', "/");
    p.contains("/.claude/plans/")
        || claude_dir().is_some_and(|d| Path::new(path).starts_with(d.join("plans")))
}

/// The text of a tool result, which is either a string or a list of content blocks.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The first claude.ai artifact link in `text`.
fn artifact_url(text: &str) -> Option<String> {
    for prefix in ["https://claude.ai/code/artifact/", "https://claude.ai/artifact/"] {
        if let Some(i) = text.find(prefix) {
            let rest = &text[i + prefix.len()..];
            let id: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
            if !id.is_empty() {
                return Some(format!("{prefix}{id}"));
            }
        }
    }
    None
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

impl Tracked {
    /// Adds `doc`, or updates the one it names, and moves it to the end (newest).
    fn touch(&mut self, mut doc: Doc) {
        let same = |d: &Doc| match (&doc.url, &d.url) {
            (Some(a), Some(b)) => a == b,
            (None, None) => doc.kind == d.kind && doc.path == d.path,
            _ => false,
        };
        if let Some(i) = self.docs.iter().position(same) {
            let old = self.docs.remove(i);
            doc.writes += old.writes;
            doc.title = doc.title.or(old.title);
            doc.description = doc.description.or(old.description);
        }
        if let Some(p) = &doc.path {
            lock(known()).insert(PathBuf::from(p));
        }
        self.docs.push(doc);
    }

    fn add(&mut self, line: &[u8]) {
        if !contains(line, b"\"tool_use\"") && !contains(line, b"\"tool_result\"") {
            return;
        }
        let Ok(e) = serde_json::from_slice::<Value>(line) else { return };
        let at = str_of(&e, "timestamp").map(str::to_owned);
        let Some(Value::Array(blocks)) = e.get("message").and_then(|m| m.get("content")) else { return };
        for b in blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("tool_use") => self.tool_use(b, &at),
                Some("tool_result") => {
                    let Some(id) = str_of(b, "tool_use_id") else { continue };
                    let Some(mut doc) = self.pending.remove(id) else { continue };
                    if b.get("is_error").and_then(Value::as_bool) == Some(true) {
                        continue;
                    }
                    if doc.kind == "artifact" {
                        let text = result_text(b.get("content"));
                        // Only publishes that went through; other artifact calls (reads,
                        // listings, uploads) carry no link of their own.
                        let Some(url) = artifact_url(&text).filter(|_| text.contains("Published")) else { continue };
                        doc.url = Some(url);
                    }
                    self.touch(doc);
                }
                _ => {}
            }
        }
    }

    fn tool_use(&mut self, b: &Value, at: &Option<String>) {
        let (Some(name), Some(id), Some(input)) = (str_of(b, "name"), str_of(b, "id"), b.get("input")) else { return };
        let doc = |kind, path: Option<&str>| Doc {
            kind,
            path: path.map(str::to_owned),
            url: None,
            title: None,
            description: None,
            text: None,
            at: at.clone(),
            writes: 1,
        };
        match name {
            "Write" | "Edit" | "MultiEdit" => {
                let Some(path) = str_of(input, "file_path") else { return };
                if is_markdown(path) {
                    let kind = if is_plan_file(path) { "plan" } else { "markdown" };
                    self.pending.insert(id.to_owned(), doc(kind, Some(path)));
                }
            }
            // The plan Claude asks to go ahead with. It counts even if the user turns it
            // down: that's when they most want to read it again.
            "ExitPlanMode" => {
                let path = str_of(input, "planFilePath").or_else(|| str_of(input, "plan_file_path"));
                let mut d = doc("plan", path);
                if path.is_none() {
                    let Some(text) = str_of(input, "plan") else { return };
                    d.text = Some(text.to_owned());
                }
                self.touch(d);
            }
            "Artifact" => {
                let action = str_of(input, "action").unwrap_or("publish");
                let asset = input.get("asset").and_then(Value::as_bool) == Some(true);
                if action != "publish" || asset {
                    return;
                }
                let Some(path) = str_of(input, "file_path") else { return };
                let mut d = doc("artifact", Some(path));
                d.title = str_of(input, "title").map(str::to_owned);
                d.description = str_of(input, "description").map(str::to_owned);
                self.pending.insert(id.to_owned(), d);
            }
            _ => {}
        }
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Documents of the conversation file at `path`, newest first.
fn documents_of(path: &Path) -> Vec<Doc> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Tracked>>> = OnceLock::new();
    let Ok(mut file) = fs::File::open(path) else { return Vec::new() };
    let Ok(len) = file.metadata().map(|m| m.len()) else { return Vec::new() };
    let mut cache = lock(CACHE.get_or_init(Default::default));
    let t = cache.entry(path.to_path_buf()).or_default();
    if len < t.offset {
        *t = Tracked::default(); // rewritten or truncated: start over
    }
    if len > t.offset && file.seek(SeekFrom::Start(t.offset)).is_ok() {
        let mut buf = Vec::with_capacity((len - t.offset) as usize);
        if file.take(len - t.offset).read_to_end(&mut buf).is_ok() {
            // Only whole lines; a line still being written is read next time.
            let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
            for line in buf[..end].split(|&b| b == b'\n') {
                t.add(line);
            }
            t.offset += end as u64;
        }
    }
    t.docs.iter().rev().cloned().collect()
}

/// The documents conversation `id` in `cwd` has produced so far, newest first.
#[tauri::command]
pub async fn conversation_documents(cwd: String, id: String) -> Vec<Doc> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Vec::new();
    }
    let Some(path) = claude_dir().map(|d| d.join("projects").join(project_key(&cwd)).join(format!("{id}.jsonl"))) else {
        return Vec::new();
    };
    tauri::async_runtime::spawn_blocking(move || documents_of(&path)).await.unwrap_or_default()
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DocText {
    pub text: String,
    /// Milliseconds since 1970 of the last change, so unchanged files needn't be re-rendered.
    pub modified: u64,
}

/// The file `path`, if a conversation produced it and it isn't too big.
fn read_known(path: &Path) -> Result<DocText, String> {
    if !lock(known()).contains(path) {
        return Err("not a document of an open conversation".into());
    }
    let meta = fs::metadata(path).map_err(|_| "The file no longer exists.".to_string())?;
    if meta.len() > MAX_READ {
        return Err(format!("The file is too large to show ({} MB).", meta.len() / (1024 * 1024)));
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    Ok(DocText { text: String::from_utf8_lossy(&bytes).into_owned(), modified })
}

#[tauri::command]
pub async fn read_document(path: String) -> Result<DocText, String> {
    tauri::async_runtime::spawn_blocking(move || read_known(Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// Lets an artifact's page run in the preview: its fonts, scripts and styles usually
/// come from CDNs. The page runs in a sandboxed frame with an opaque origin, so it can't
/// reach the app's storage or commands either way.
const PREVIEW_CSP: &str = "default-src 'none'; script-src https: 'unsafe-inline' 'unsafe-eval'; style-src https: 'unsafe-inline'; \
font-src https: data:; img-src https: data: blob:; media-src https: data: blob:; connect-src https:";

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

/// The `swpreview` scheme: `swpreview://localhost/<hex of the path>` serves an
/// artifact's page (Windows: `http://swpreview.localhost/<hex>`).
pub fn preview(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", PREVIEW_CSP)
            .header("Cache-Control", "no-store")
            .body(body)
            .unwrap_or_default()
    };
    let hex = request.uri().path().trim_start_matches('/');
    let Some(path) = from_hex(hex).and_then(|b| String::from_utf8(b).ok()) else {
        return respond(400, b"Bad preview address".to_vec());
    };
    match read_known(Path::new(&path)) {
        Ok(doc) => respond(200, page(&doc.text).into_bytes()),
        Err(e) => respond(404, format!("<p style=\"font:14px system-ui;padding:16px\">{}</p>", escape(&e)).into_bytes()),
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The artifact's source as a whole page. The Artifact tool takes page fragments (no
/// doctype or head) and wraps them when it publishes; do the same.
fn page(src: &str) -> String {
    let head = src.trim_start().get(..15).unwrap_or("").to_ascii_lowercase();
    if head.starts_with("<!doctype") || head.starts_with("<html") {
        return src.to_owned();
    }
    format!(
        "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">\
<style>*,*::before,*::after{{box-sizing:border-box}}body{{margin:0}}</style></head><body>{src}</body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn use_line(id: &str, name: &str, input: Value) -> String {
        serde_json::json!({"type":"assistant","timestamp":"2026-11-13T10:00:00Z","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":input}]}}).to_string() + "\n"
    }
    fn result_line(id: &str, content: Value, error: bool) -> String {
        serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":id,"content":content,"is_error":error}]}}).to_string() + "\n"
    }

    #[test]
    fn finds_markdown_plans_and_artifacts() {
        let path = std::env::temp_dir().join(format!("switchyard-docs-{}.jsonl", std::process::id()));
        let mut f = fs::File::create(&path).unwrap();
        let lines = [
            use_line("w1", "Write", serde_json::json!({"file_path":"/p/PLAN.md","content":"# x"})),
            result_line("w1", Value::String("File created".into()), false),
            use_line("w2", "Write", serde_json::json!({"file_path":"/p/main.rs","content":"fn main(){}"})),
            result_line("w2", Value::String("ok".into()), false),
            // A failed write doesn't count.
            use_line("w3", "Write", serde_json::json!({"file_path":"/p/NOPE.md","content":""})),
            result_line("w3", Value::String("denied".into()), true),
            use_line("p1", "ExitPlanMode", serde_json::json!({"plan":"1. do it"})),
            use_line("a1", "Artifact", serde_json::json!({"file_path":"/s/page.html","description":"A page"})),
            result_line("a1", serde_json::json!([{"type":"text","text":"Published /s/page.html at https://claude.ai/artifact/AbC123 (Version 1)"}]), false),
            use_line("a2", "Artifact", serde_json::json!({"action":"list"})),
            result_line("a2", Value::String("https://claude.ai/artifact/Other".into()), false),
        ];
        for l in &lines {
            write!(f, "{l}").unwrap();
        }
        f.flush().unwrap();
        let docs = documents_of(&path);
        let kinds: Vec<_> = docs.iter().map(|d| d.kind).collect();
        assert_eq!(kinds, ["artifact", "plan", "markdown"], "{docs:?}");
        assert_eq!(docs[0].url.as_deref(), Some("https://claude.ai/artifact/AbC123"));
        assert_eq!(docs[0].description.as_deref(), Some("A page"));
        assert_eq!(docs[1].text.as_deref(), Some("1. do it"));
        assert_eq!(docs[2].path.as_deref(), Some("/p/PLAN.md"));

        // Editing the markdown again moves it to the top and counts the write; a
        // tool call whose result hasn't arrived yet doesn't count.
        write!(f, "{}", use_line("e1", "Edit", serde_json::json!({"file_path":"/p/PLAN.md"}))).unwrap();
        f.flush().unwrap();
        assert_eq!(documents_of(&path)[0].kind, "artifact");
        write!(f, "{}", result_line("e1", Value::String("ok".into()), false)).unwrap();
        f.flush().unwrap();
        let docs = documents_of(&path);
        assert_eq!((docs[0].path.as_deref(), docs[0].writes, docs.len()), (Some("/p/PLAN.md"), 2, 3));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn only_known_files_can_be_read() {
        let dir = std::env::temp_dir().join(format!("switchyard-docs-read-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes.md");
        fs::write(&file, "# Notes").unwrap();
        assert!(read_known(&file).is_err());
        lock(known()).insert(file.clone());
        assert_eq!(read_known(&file).unwrap().text, "# Notes");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn plan_files_and_links() {
        assert!(is_plan_file("/home/me/.claude/plans/brave-otter.md"));
        assert!(is_plan_file(r"C:\Users\me\.claude\plans\x.md"));
        assert!(!is_plan_file("/repo/docs/plan.md"));
        assert_eq!(artifact_url("at https://claude.ai/artifact/4qx_k-1 (V1)").as_deref(), Some("https://claude.ai/artifact/4qx_k-1"));
        assert_eq!(artifact_url("nothing"), None);
        assert_eq!(from_hex(&"/a b.html".bytes().map(|b| format!("{b:02x}")).collect::<String>()).unwrap(), b"/a b.html");
        assert!(page("<title>x</title>").starts_with("<!doctype html>"));
        assert_eq!(page("<!DOCTYPE html><p>"), "<!DOCTYPE html><p>");
    }
}

#[cfg(test)]
mod real {
    //! DOCS_FILE=<a .jsonl> cargo test --release docs_of_file -- --ignored --nocapture
    #[test]
    #[ignore]
    fn docs_of_file() {
        let Some(path) = std::env::var_os("DOCS_FILE") else { return };
        for d in super::documents_of(std::path::Path::new(&path)) {
            println!("{} {:?} {:?} {:?} x{}", d.kind, d.path, d.url, d.description, d.writes);
        }
    }
}
