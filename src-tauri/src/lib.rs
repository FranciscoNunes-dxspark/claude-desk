use tauri::Manager;

mod docs;
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
        // Artifact previews in the documents panel (docs::preview).
        .register_uri_scheme_protocol("swpreview", |_ctx, request| docs::preview(&request))
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                // Windows: the app draws its own title bar and window buttons (index.html
                // #win-controls); the window keeps its resize edges, snapping and shadow.
                // macOS keeps its native buttons over the app's top bar (titleBarStyle
                // "Overlay"); Linux keeps the system frame, as an undecorated window there
                // can't be resized from its edges.
                #[cfg(windows)]
                let _ = window.set_decorations(false);
                // The window starts hidden (tauri.conf.json) so the system frame never
                // flashes before it's removed.
                let _ = window.show();
            }
            Ok(())
        })
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
            docs::conversation_documents,
            docs::read_document,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
