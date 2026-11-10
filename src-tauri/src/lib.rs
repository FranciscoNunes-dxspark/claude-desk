mod extras;
mod pty;

pub fn run() {
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
            pty::claude_version,
            extras::list_conversations,
            extras::conversation_exists,
            extras::git_branch,
            extras::save_clipboard_image,
            extras::read_clipboard_text,
            extras::write_clipboard_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
