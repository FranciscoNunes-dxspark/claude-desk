mod extras;
mod git;
mod migrate;
mod pty;
mod usage;

pub fn run() {
    // Before any web view exists: bring over the data kept under the old identifier.
    migrate::from_old_identifier();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_ack,
            pty::pty_kill,
            pty::pty_status,
            pty::claude_version,
            extras::list_conversations,
            extras::list_all_conversations,
            git::worktree_info,
            git::git_changes,
            git::git_diff,
            extras::conversation_exists,
            extras::git_branch,
            extras::save_clipboard_image,
            extras::read_clipboard_text,
            extras::write_clipboard_text,
            usage::conversation_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
