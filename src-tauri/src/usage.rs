//! Token usage of a session's conversation, read from the file Claude Code writes
//! (`~/.claude/projects/<folder>/<id>.jsonl`). Only what was appended since the last
//! call is read, so polling a long conversation stays cheap.

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::extras::{claude_dir, project_key};

#[derive(Clone, Default, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    /// Tokens sent in the latest main-thread request: what the context holds now.
    pub context: u64,
    /// Totals over the conversation (subagents included).
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub requests: u32,
    pub model: Option<String>,
}

#[derive(Deserialize, Default, Clone, Copy)]
struct Counts {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Counts>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    is_sidechain: bool,
    message: Option<Message>,
}

#[derive(Default)]
struct Tracked {
    offset: u64,
    usage: Usage,
    /// The last request seen: Claude Code writes one line per content block, each
    /// repeating the request's usage, so a repeat replaces it instead of adding.
    last_id: Option<String>,
    last: Counts,
}

impl Tracked {
    fn add(&mut self, line: &[u8]) {
        // Cheap pre-filter: most lines are prompts, tool results and bookkeeping.
        if !contains(line, b"\"usage\"") || !contains(line, b"\"assistant\"") {
            return;
        }
        let Ok(e) = serde_json::from_slice::<Entry>(line) else { return };
        let Some(m) = e.message.filter(|_| e.kind.as_deref() == Some("assistant")) else { return };
        let Some(c) = m.usage else { return };
        if m.model.as_deref() == Some("<synthetic>") {
            return; // local placeholder messages (errors, interruptions), not API calls
        }
        let u = &mut self.usage;
        if m.id.is_some() && m.id == self.last_id {
            let p = self.last;
            u.input -= p.input_tokens;
            u.cache_write -= p.cache_creation_input_tokens;
            u.cache_read -= p.cache_read_input_tokens;
            u.output -= p.output_tokens;
        } else {
            u.requests += 1;
        }
        u.input += c.input_tokens;
        u.cache_write += c.cache_creation_input_tokens;
        u.cache_read += c.cache_read_input_tokens;
        u.output += c.output_tokens;
        if !e.is_sidechain {
            u.context = c.input_tokens + c.cache_creation_input_tokens + c.cache_read_input_tokens;
            if m.model.is_some() {
                u.model = m.model;
            }
        }
        self.last_id = m.id;
        self.last = c;
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Usage of the conversation file at `path`, reading only what's new since last time.
fn usage_of(path: &Path) -> Option<Usage> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, Tracked>>> = OnceLock::new();
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
    let t = cache.entry(path.to_path_buf()).or_default();
    if len < t.offset {
        *t = Tracked::default(); // rewritten or truncated: start over
    }
    if len > t.offset {
        file.seek(SeekFrom::Start(t.offset)).ok()?;
        let mut buf = Vec::with_capacity((len - t.offset) as usize);
        file.take(len - t.offset).read_to_end(&mut buf).ok()?;
        // Only whole lines; a line still being written is read next time.
        let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
        for line in buf[..end].split(|&b| b == b'\n') {
            t.add(line);
        }
        t.offset += end as u64;
    }
    Some(t.usage.clone()).filter(|u| u.requests > 0)
}

/// Token usage of conversation `id` in `cwd`, or `None` until Claude Code has made a request.
#[tauri::command]
pub async fn conversation_usage(cwd: String, id: String) -> Option<Usage> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let path = claude_dir()?.join("projects").join(project_key(&cwd)).join(format!("{id}.jsonl"));
    tauri::async_runtime::spawn_blocking(move || usage_of(&path)).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(id: &str, side: bool, i: u64, cw: u64, cr: u64, o: u64) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":{side},"message":{{"id":"{id}","model":"m","content":[{{"type":"text","text":"usage \"assistant\""}}],"usage":{{"input_tokens":{i},"cache_creation_input_tokens":{cw},"cache_read_input_tokens":{cr},"output_tokens":{o}}}}}}}"#
        ) + "\n"
    }

    #[test]
    fn counts_each_request_once_and_reads_incrementally() {
        let path = std::env::temp_dir().join(format!("claude-desk-usage-{}.jsonl", std::process::id()));
        let mut f = fs::File::create(&path).unwrap();
        write!(f, "{}", r#"{"type":"user","message":{"content":"hi"}}"#.to_string() + "\n").unwrap();
        // One request written as two content-block lines (same id, same usage).
        write!(f, "{}{}", line("a", false, 10, 100, 0, 5), line("a", false, 10, 100, 0, 5)).unwrap();
        // A subagent request: counted in totals, not in the context.
        write!(f, "{}", line("s", true, 3, 0, 900, 7)).unwrap();
        f.flush().unwrap();
        let u = usage_of(&path).unwrap();
        assert_eq!((u.requests, u.input, u.cache_write, u.cache_read, u.output, u.context), (3 - 1, 13, 100, 900, 12, 110));

        // Appended later, plus half a line still being written.
        write!(f, "{}", line("b", false, 2, 50, 110, 9)).unwrap();
        let next = line("c", false, 1, 1, 1, 1);
        write!(f, "{}", &next[..20]).unwrap();
        f.flush().unwrap();
        let u = usage_of(&path).unwrap();
        assert_eq!((u.requests, u.context, u.output), (3, 162, 21));
        write!(f, "{}", &next[20..]).unwrap();
        f.flush().unwrap();
        let u = usage_of(&path).unwrap();
        assert_eq!((u.requests, u.context), (4, 3));
        let _ = fs::remove_file(&path);
    }
}

#[cfg(test)]
mod perf {
    //! USAGE_FILE=<a .jsonl> cargo test --release perf_usage -- --ignored --nocapture
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn perf_usage() {
        let Some(path) = std::env::var_os("USAGE_FILE").map(PathBuf::from) else { return };
        let t = Instant::now();
        let u = usage_of(&path);
        println!("first read ({} KB): {:?} in {:?}", fs::metadata(&path).unwrap().len() / 1024, u, t.elapsed());
        let t = Instant::now();
        let _ = usage_of(&path);
        println!("next poll: {:?}", t.elapsed());
    }
}
