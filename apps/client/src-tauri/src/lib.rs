use tauri::Manager;

mod config;
mod ws_server;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn network_connect(network_id: &str) -> String {
    format!("Network Id set to: {}", network_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // NOTE: Currently, plugins run in the order they were added in to the builder,
        // so `tauri_plugin_single_instance` needs to be registered first.
        // See: https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/single-instance
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            #[cfg(desktop)]
            {
                let windows = app.webview_windows();
                for (name, window) in windows {
                    if name == "main" {
                        window.show().unwrap();
                        window.unminimize().unwrap();
                        window.set_focus().unwrap();
                        break;
                    }
                }
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ws_server::ConnMap::default())
        .setup(|app| {
            // load config from tauri.conf.json:plugins.zknet
            // the plugins section is used for its schema flexibility
            let cfg = config::plugin_cfg::<_, config::ZKNetClientCfg>(&app.handle(), "zknet");
            app.manage(cfg);

            // start a WebSocket server for local API requests
            let addr = &app.state::<config::ZKNetClientCfg>().api_listen_address;
            ws_server::start(&app.handle(), addr);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            network_connect,
            config::cfg,
            ws_server::api_reply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
