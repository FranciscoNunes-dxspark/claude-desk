//! One-time move of the app's data from its old identifier to the new one.
//!
//! The app was Claude Desk (`com.dxspark.claudedesk`) and is now Switchyard
//! (`com.dxspark.switchyard`). The web view keeps its storage, which holds the settings,
//! open sessions, recent folders and per-project defaults, in folders named after the
//! identifier, so without this the renamed app would start empty. Runs before any window
//! (and so any web view) exists. Claude Code's own conversations live in ~/.claude and
//! aren't affected either way.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The identifier before the rename.
pub const OLD_ID: &str = "com.dxspark.claudedesk";
/// The identifier now (tauri.conf.json's `identifier`; a test keeps the two in step).
pub const NEW_ID: &str = "com.dxspark.switchyard";

/// The folders, per identifier, where this platform's web view and Tauri keep app data.
fn data_dirs(id: &str) -> Vec<PathBuf> {
    // An empty variable counts as unset (as the XDG spec says); taken as a path it
    // would point at the current folder.
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let mut bases: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        // WebView2's profile (EBWebView) lives under LOCALAPPDATA\<identifier>.
        bases.extend(env("LOCALAPPDATA"));
        bases.extend(env("APPDATA"));
    } else if cfg!(target_os = "macos") {
        if let Some(home) = env("HOME") {
            bases.push(home.join("Library/WebKit"));
            bases.push(home.join("Library/Application Support"));
        }
    } else {
        bases.extend(env("XDG_DATA_HOME").or_else(|| env("HOME").map(|h| h.join(".local/share"))));
    }
    bases.into_iter().map(|b| b.join(id)).collect()
}

/// Copies the old identifier's data to the new one's, where the new one has none yet.
pub fn from_old_identifier() {
    for (old, new) in data_dirs(OLD_ID).into_iter().zip(data_dirs(NEW_ID)) {
        match copy_once(&old, &new) {
            Ok(true) => eprintln!("switchyard: carried over data from {}", old.display()),
            Ok(false) => {}
            // Starting with empty settings beats not starting; the old folder is untouched.
            Err(e) => eprintln!("switchyard: couldn't carry over {}: {e}", old.display()),
        }
    }
}

/// Copies the folder `old` to `new` unless `new` already exists (or `old` doesn't).
/// The copy is made beside `new` and renamed into place at the end, so a copy that
/// fails halfway never looks like a finished one. Returns whether it copied.
fn copy_once(old: &Path, new: &Path) -> io::Result<bool> {
    if new.exists() || !old.is_dir() {
        return Ok(false);
    }
    let mut partial = new.as_os_str().to_owned();
    partial.push(".migrating");
    let partial = PathBuf::from(partial);
    let _ = fs::remove_dir_all(&partial); // left over from an interrupted attempt
    let result = copy_tree(old, &partial).and_then(|()| fs::rename(&partial, new));
    if result.is_err() {
        let _ = fs::remove_dir_all(&partial);
    }
    result.map(|()| true)
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
        // Symlinks are skipped: the web view's profile has none, and following one
        // could copy something outside the app's folder.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("switchyard-migrate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn data_dirs_are_absolute_even_with_empty_variables() {
        for k in ["XDG_DATA_HOME", "LOCALAPPDATA", "APPDATA"] {
            std::env::set_var(k, "");
        }
        let dirs = data_dirs(OLD_ID);
        assert!(!dirs.is_empty());
        assert!(dirs.iter().all(|d| d.is_absolute()), "{dirs:?}");
    }

    #[test]
    fn identifier_matches_tauri_conf() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], NEW_ID);
    }

    #[test]
    fn copies_the_old_data_once() {
        let root = temp("copy");
        let (old, new) = (root.join(OLD_ID), root.join(NEW_ID));
        fs::create_dir_all(old.join("EBWebView/Default/Local Storage")).unwrap();
        fs::write(old.join("EBWebView/Default/Local Storage/leveldb.log"), "settings").unwrap();
        fs::write(old.join("top.txt"), "x").unwrap();

        assert!(copy_once(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("EBWebView/Default/Local Storage/leveldb.log")).unwrap(), "settings");
        assert_eq!(fs::read_to_string(new.join("top.txt")).unwrap(), "x");
        assert!(old.join("top.txt").exists(), "the old data must stay");
        assert!(!root.join(format!("{NEW_ID}.migrating")).exists());

        // Never again once the new folder exists, even if the old one changes.
        fs::write(old.join("top.txt"), "changed").unwrap();
        assert!(!copy_once(&old, &new).unwrap());
        assert_eq!(fs::read_to_string(new.join("top.txt")).unwrap(), "x");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_to_carry_over() {
        let root = temp("none");
        assert!(!copy_once(&root.join(OLD_ID), &root.join(NEW_ID)).unwrap());
        assert!(!root.join(NEW_ID).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_interrupted_copy_is_redone() {
        let root = temp("partial");
        let (old, new) = (root.join(OLD_ID), root.join(NEW_ID));
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("a"), "1").unwrap();
        // A previous attempt died halfway: its leftovers must not count.
        fs::create_dir_all(root.join(format!("{NEW_ID}.migrating"))).unwrap();
        fs::write(root.join(format!("{NEW_ID}.migrating/junk")), "").unwrap();
        assert!(copy_once(&old, &new).unwrap());
        assert!(new.join("a").exists() && !new.join("junk").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
