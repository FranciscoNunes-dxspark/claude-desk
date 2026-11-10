//! Git helpers for the UI: the repository root, the folder Claude Code uses for a
//! `--worktree`, and the changes panel (changed files and their diffs).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// The folder containing `.git` (a directory, or a file for worktrees/submodules).
fn repo_root(cwd: &Path) -> Option<PathBuf> {
    let mut dir = cwd.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    /// The repository's root folder.
    root: String,
    /// Where `claude --worktree <name>` puts the worktree.
    path: String,
    /// Whether it exists yet (Claude Code creates it on first start).
    exists: bool,
}

/// Where Claude Code's `--worktree <name>` lives for the repository containing `cwd`:
/// `<repo root>/.claude/worktrees/<name>`. `None` when `cwd` isn't in a git repository.
#[tauri::command]
pub fn worktree_info(cwd: String, name: String) -> Option<WorktreeInfo> {
    let root = repo_root(Path::new(&cwd))?;
    let path = root.join(".claude").join("worktrees").join(&name);
    Some(WorktreeInfo {
        root: root.to_string_lossy().into_owned(),
        exists: path.is_dir(),
        path: path.to_string_lossy().into_owned(),
    })
}

fn git(dir: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    // Keep git's output stable and free of pagers/colour regardless of user config.
    cmd.env("GIT_PAGER", "cat").env("LC_ALL", "C").env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git isn't installed (or isn't on PATH)".to_string()
        } else {
            format!("couldn't run git: {e}")
        }
    })?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    /// Two-letter porcelain status, e.g. " M", "A ", "??", " D", "R ".
    status: String,
    added: Option<u64>,
    removed: Option<u64>,
    binary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    branch: Option<String>,
    files: Vec<Change>,
}

fn count_lines(path: &Path) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 4 * 1024 * 1024 {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if data.contains(&0) {
        return None; // binary
    }
    Some(data.iter().filter(|&&b| b == b'\n').count() as u64 + u64::from(!data.is_empty() && !data.ends_with(b"\n")))
}

/// Changed files in the working tree (against HEAD), with added/removed line counts.
#[tauri::command]
pub async fn git_changes(dir: String) -> Result<Changes, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let status = git(&dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
        let branch = git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"])
            .ok()
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());
        // numstat against HEAD; a repository without commits yet has no HEAD.
        let numstat = git(&dir, &["diff", "HEAD", "--numstat", "-z", "-M"]).unwrap_or_default();

        let mut counts = std::collections::HashMap::new();
        let mut it = numstat.split(|&b| b == 0).peekable();
        while let Some(rec) = it.next() {
            if rec.is_empty() {
                continue;
            }
            let s = String::from_utf8_lossy(rec);
            let mut parts = s.splitn(3, '\t');
            let (a, r, p) = (parts.next(), parts.next(), parts.next());
            let path = match p {
                // A rename: "a\tr\t" then old and new paths as separate records.
                Some("") => {
                    let _old = it.next();
                    it.next().map(|n| String::from_utf8_lossy(n).into_owned())
                }
                Some(p) => Some(p.to_string()),
                None => None,
            };
            if let Some(path) = path {
                counts.insert(path, (a.and_then(|v| v.parse::<u64>().ok()), r.and_then(|v| v.parse::<u64>().ok())));
            }
        }

        let mut files = Vec::new();
        let mut recs = status.split(|&b| b == 0);
        while let Some(rec) = recs.next() {
            if rec.len() < 4 {
                continue;
            }
            let code = String::from_utf8_lossy(&rec[..2]).into_owned();
            let path = String::from_utf8_lossy(&rec[3..]).into_owned();
            if code.starts_with('R') || code.starts_with('C') {
                recs.next(); // the original path follows a rename/copy
            }
            let (mut added, mut removed, mut binary) = (None, None, false);
            if code == "??" {
                match count_lines(&Path::new(&dir).join(&path)) {
                    Some(n) => {
                        added = Some(n);
                        removed = Some(0);
                    }
                    None => binary = true,
                }
            } else if let Some(&(a, r)) = counts.get(&path) {
                added = a;
                removed = r;
                binary = a.is_none() && r.is_none();
            }
            files.push(Change { path, status: code, added, removed, binary });
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Changes { branch, files })
    })
    .await
    .map_err(|e| e.to_string())?
}

const MAX_DIFF: usize = 512 * 1024;

/// The unified diff of one file against HEAD (an untracked file shows as all added).
#[tauri::command]
pub async fn git_diff(dir: String, path: String, untracked: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut text = if untracked {
            let full = Path::new(&dir).join(&path);
            let data = std::fs::read(&full).map_err(|e| e.to_string())?;
            if data.contains(&0) {
                return Ok("Binary file".to_string());
            }
            let body = String::from_utf8_lossy(&data[..data.len().min(MAX_DIFF)]).into_owned();
            let lines: Vec<&str> = body.lines().collect();
            let mut out = format!("--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
            for l in lines {
                out.push('+');
                out.push_str(l);
                out.push('\n');
            }
            out
        } else {
            let bytes = git(&dir, &["diff", "HEAD", "-M", "--", &path])
                .or_else(|_| git(&dir, &["diff", "--cached", "--", &path]))?;
            String::from_utf8_lossy(&bytes).into_owned()
        };
        if text.len() > MAX_DIFF {
            let mut cut = MAX_DIFF;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            text.push_str("\n… (diff truncated)\n");
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?} failed");
    }

    #[test]
    fn changes_and_diffs() {
        let dir = std::env::temp_dir().join(format!("claude-desk-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        run(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("src/a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.join("old.txt"), "x\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
        std::fs::write(dir.join("src/a.txt"), "one\n2\nthree\nfour\n").unwrap();
        std::fs::write(dir.join("new file.txt"), "hello\nworld\n").unwrap();
        std::fs::remove_file(dir.join("old.txt")).unwrap();

        let d = dir.to_string_lossy().into_owned();
        let c = tauri::async_runtime::block_on(git_changes(d.clone())).unwrap();
        let get = |p: &str| c.files.iter().find(|f| f.path == p).unwrap();
        assert_eq!(c.branch.as_deref(), Some("main"));
        assert_eq!((get("src/a.txt").status.as_str(), get("src/a.txt").added, get("src/a.txt").removed), (" M", Some(2), Some(1)));
        assert_eq!((get("new file.txt").status.as_str(), get("new file.txt").added), ("??", Some(2)));
        assert_eq!((get("old.txt").status.as_str(), get("old.txt").removed), (" D", Some(1)));

        let diff = tauri::async_runtime::block_on(git_diff(d.clone(), "src/a.txt".into(), false)).unwrap();
        assert!(diff.contains("-two") && diff.contains("+2") && diff.contains("+four"), "{diff}");
        let untracked = tauri::async_runtime::block_on(git_diff(d.clone(), "new file.txt".into(), true)).unwrap();
        assert!(untracked.contains("+hello") && untracked.contains("+world"), "{untracked}");

        let wt = worktree_info(dir.join("src").to_string_lossy().into_owned(), "feature".into()).unwrap();
        assert!(wt.path.ends_with(&format!(".claude{}worktrees{}feature", std::path::MAIN_SEPARATOR, std::path::MAIN_SEPARATOR)));
        assert!(!wt.exists);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod perf {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn perf_git_changes() {
        let dir = std::env::temp_dir().join("claude-desk-perf-git");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(Command::new("git").arg("-C").arg(&dir).args(args).output().unwrap().status.success());
        run(&["init", "-q", "-b", "main"]);
        // A mid-sized repository: 20,000 files in 200 folders.
        for d in 0..200 {
            let sub = dir.join(format!("pkg{d}"));
            std::fs::create_dir_all(&sub).unwrap();
            for f in 0..100 {
                std::fs::write(sub.join(format!("f{f}.ts")), format!("export const v{f} = {d};\n").repeat(20)).unwrap();
            }
        }
        run(&["add", "."]);
        run(&["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
        for d in 0..20 {
            std::fs::write(dir.join(format!("pkg{d}/f1.ts")), "changed\n").unwrap();
        }
        let d = dir.to_string_lossy().into_owned();
        let _ = tauri::async_runtime::block_on(git_changes(d.clone())); // warm the OS cache
        let t = Instant::now();
        let n = 5;
        for _ in 0..n {
            let c = tauri::async_runtime::block_on(git_changes(d.clone())).unwrap();
            assert_eq!(c.files.len(), 20);
        }
        println!("git_changes on 20,000 files (20 changed): {:?} per refresh", t.elapsed() / n);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
