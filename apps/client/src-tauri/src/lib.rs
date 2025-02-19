// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn network_connect(network_id: &str) -> String {
    format!("Network Id set to: {}", network_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                // https://tauri.app/plugin/logging/#formatting
                // https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/log/src/lib.rs#L278
                .format(|out, message, record| {
                    let tf = time::format_description::parse(
                        "[year]-[month]-[day] [hour]:[minute]:[second]",
                    )
                    .unwrap();

                    let newline = match tauri_plugin_os::platform() {
                        "windows" => "\r",
                        _ => "",
                    };

                    out.finish(format_args!(
                        "[{}][{}] {}{}",
                        tauri_plugin_log::TimezoneStrategy::UseUtc
                            .get_now()
                            .format(&tf)
                            .unwrap(),
                        record.level(),
                        message,
                        newline
                    ))
                })
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_upload::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![network_connect])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
