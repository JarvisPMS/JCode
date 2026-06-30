mod commands;
mod models;

use std::path::PathBuf;

use tauri::{
    image::Image,
    menu::{IconMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_store::StoreExt;

use crate::commands::batch_test::BatchTestState;
use crate::commands::launch::launch_platform;
use crate::commands::proxy::ProxyState;
use crate::models::platform::PlatformConfig;

fn load_platform_icon(app: &tauri::AppHandle, icon_name: &str) -> Option<Image<'static>> {
    let candidates = [
        app.path().resource_dir().ok().map(|d| d.join("platform-icons").join(icon_name)),
        Some(PathBuf::from(format!("../dist/platform-icons/{}", icon_name))),
        Some(PathBuf::from(format!("public/platform-icons/{}", icon_name))),
    ];

    for candidate in candidates.iter().flatten() {
        if !candidate.exists() {
            continue;
        }
        // SVG → 渲染成 RGBA
        if icon_name.ends_with(".svg") {
            if let Some(img) = svg_to_image(candidate) {
                return Some(img);
            }
        } else if let Ok(img) = Image::from_path(candidate) {
            return Some(img);
        }
    }
    None
}

fn svg_to_image(path: &std::path::Path) -> Option<Image<'static>> {
    let data = std::fs::read(path).ok()?;
    let tree = resvg::usvg::Tree::from_data(&data, &resvg::usvg::Options::default()).ok()?;

    // 渲染成 32x32 的菜单图标
    let target_size = 32u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(target_size, target_size)?;

    let svg_size = tree.size();
    let sx = target_size as f32 / svg_size.width();
    let sy = target_size as f32 / svg_size.height();
    let scale = sx.min(sy);
    let dx = (target_size as f32 - svg_size.width() * scale) / 2.0;
    let dy = (target_size as f32 - svg_size.height() * scale) / 2.0;

    let transform = resvg::tiny_skia::Transform::from_scale(scale, scale)
        .post_translate(dx, dy);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    Some(Image::new_owned(pixmap.data().to_vec(), target_size, target_size))
}

fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    // 读取平台列表
    let platforms: Vec<PlatformConfig> = app
        .store("platforms.json")
        .ok()
        .and_then(|store| store.get("platforms"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let mut sorted = platforms;
    sorted.sort_by_key(|p| p.order);

    // 构建平台子菜单
    let mut submenu = SubmenuBuilder::new(app, "启动平台");
    for p in &sorted {
        let menu_id = format!("platform_{}", p.id);
        if let Some(icon) = load_platform_icon(app, &p.icon) {
            let item = IconMenuItemBuilder::with_id(menu_id, &p.name)
                .icon(icon)
                .build(app)?;
            submenu = submenu.item(&item);
        } else {
            let item = MenuItemBuilder::with_id(menu_id, &p.name).build(app)?;
            submenu = submenu.item(&item);
        }
    }

    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&submenu.build()?)
        .separator()
        .item(&quit)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 重复启动时，聚焦已有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BatchTestState::new())
        .manage(ProxyState::new())
        .invoke_handler(tauri::generate_handler![
            commands::launch::is_directory,
            commands::launch::check_claude_installed,
            commands::launch::launch_platform,
            commands::keychain::save_api_key,
            commands::keychain::delete_api_key,
            commands::keychain::has_api_key,
            commands::keychain::get_api_key,
            commands::keychain::migrate_legacy_keychain,
            commands::terminal::detect_terminals,
            commands::platform::save_platform,
            commands::platform::get_platforms,
            commands::platform::delete_platform,
            commands::platform::reorder_platforms,
            commands::backup::export_platforms,
            commands::backup::import_platforms,
            commands::backup::write_file,
            commands::batch_test::get_batch_save_dir,
            commands::batch_test::set_batch_save_dir,
            commands::batch_test::start_batch_test,
            commands::batch_test::stop_batch_test,
            commands::stats::get_token_stats,
            commands::proxy::get_proxy_config,
            commands::proxy::save_proxy_config,
            commands::proxy::get_proxy_status,
            commands::proxy::start_proxy,
            commands::proxy::stop_proxy,
            commands::settings::get_permission_mode,
            commands::settings::save_permission_mode,
            commands::settings::get_network_proxy_config,
            commands::settings::save_network_proxy_config,
        ])
        .setup(|app| {
            // 设置托盘
            let menu = build_tray_menu(app.handle())?;
            let icon = Image::from_path("icons/icon.ico")
                .or_else(|_| Image::from_path("icons/32x32.png"))
                .unwrap_or_else(|_| {
                    Image::from_bytes(include_bytes!("../icons/icon.ico")).expect("icon")
                });

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("JCode")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    if id == "quit" {
                        app.exit(0);
                    } else if id == "show" {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    } else if let Some(platform_id) = id.strip_prefix("platform_") {
                        let app_handle = app.clone();
                        let pid = platform_id.to_string();
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_dialog::DialogExt;
                            let dir = app_handle.dialog().file().blocking_pick_folder();
                            if let Some(dir_path) = dir {
                                let path_str = dir_path.to_string();
                                let _ = launch_platform(app_handle, pid, path_str);
                            }
                        });
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
