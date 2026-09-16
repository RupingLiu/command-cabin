//! Render the real Slint components without launching apps, registering hotkeys or
//! touching user data. Set CABIN_UI_SNAPSHOT_DIR to also save the rendered PNGs.
use super::*;
use slint::platform::software_renderer::{MinimalSoftwareWindow, RepaintBufferType};
use slint::platform::{Key, Platform, PlatformError, WindowAdapter, WindowEvent};
use std::cell::RefCell;

struct PreviewPlatform(Rc<RefCell<Vec<Rc<MinimalSoftwareWindow>>>>);

impl Platform for PreviewPlatform {
    fn create_window_adapter(&self) -> Result<Rc<dyn WindowAdapter>, PlatformError> {
        let adapter = MinimalSoftwareWindow::new(RepaintBufferType::NewBuffer);
        self.0.borrow_mut().push(adapter.clone());
        Ok(adapter)
    }
}

fn render(adapter: &MinimalSoftwareWindow, name: &str, width: f32, height: f32, scale: f32) {
    adapter
        .window()
        .dispatch_event(WindowEvent::ScaleFactorChanged {
            scale_factor: scale,
        });
    adapter.set_size(slint::LogicalSize::new(width, height));
    slint::platform::update_timers_and_animations();
    let size = adapter.window().size();
    let mut buffer = slint::SharedPixelBuffer::<slint::Rgb8Pixel>::new(size.width, size.height);
    adapter.window().request_redraw();
    assert!(adapter.draw_if_needed(|renderer| {
        renderer.render(buffer.make_mut_slice(), size.width as usize);
    }));
    if name.contains("dark") {
        assert!(
            buffer.as_slice()[0].r < 80,
            "dark theme must actually render dark"
        );
    }
    if let Some(output) = std::env::var_os("CABIN_UI_SNAPSHOT_DIR") {
        let output = PathBuf::from(output);
        std::fs::create_dir_all(&output).unwrap();
        image::save_buffer(
            output.join(format!("{name}.png")),
            buffer.as_bytes(),
            size.width,
            size.height,
            image::ColorType::Rgb8,
        )
        .unwrap();
    }
}

fn key(window: &slint::Window, key: Key) {
    window.dispatch_event(WindowEvent::KeyPressed { text: key.into() });
    window.dispatch_event(WindowEvent::KeyReleased { text: key.into() });
}

fn click(window: &slint::Window, x: f32, y: f32) {
    let position = slint::LogicalPosition::new(x, y);
    window.dispatch_event(WindowEvent::PointerPressed {
        position,
        button: slint::platform::PointerEventButton::Left,
    });
    window.dispatch_event(WindowEvent::PointerReleased {
        position,
        button: slint::platform::PointerEventButton::Left,
    });
    slint::platform::update_timers_and_animations();
}

#[test]
fn native_ui_navigation_and_dpi_smoke() {
    let adapters = Rc::new(RefCell::new(Vec::new()));
    slint::platform::set_platform(Box::new(PreviewPlatform(adapters.clone()))).unwrap();
    let launcher = LauncherWindow::new().unwrap();
    let settings = SettingsWindow::new().unwrap();
    let launcher_adapter = adapters.borrow()[0].clone();
    let settings_adapter = adapters.borrow()[1].clone();
    let icon = slint::Image::load_from_path(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/icon.png"),
    )
    .unwrap();
    let titles = [
        "Beyond Compare 5",
        "Clash Verge",
        "draw.io",
        "MATLAB R2025b",
        "UGit",
        "Visual Studio Code",
        "WPS Office",
        "ZCANPRO",
        "东莞银行网银（PC版）",
    ];
    let tiles: Vec<_> = titles
        .iter()
        .enumerate()
        .map(|(index, title)| PinnedTile {
            title: (*title).into(),
            icon: icon.clone(),
            command_id: format!("app.{index}").into(),
        })
        .collect();
    launcher.set_pinned_tiles(ModelRc::new(VecModel::from(tiles[..5].to_vec())));
    launcher.set_pinned_tiles_row_2(ModelRc::new(VecModel::from(tiles[5..].to_vec())));
    launcher.set_selected_tile(0);
    launcher.set_theme_mode(1);
    launcher.set_hotkey_hint("Alt+Space".into());
    push_launcher_texts(&launcher, cabin_core::settings::Language::ZhCn);
    let weak = launcher.as_weak();
    launcher.on_move_tile_selection(move |dx, dy| {
        let window = weak.unwrap();
        if let Some(next) = state::move_tile_selection(
            dx as isize,
            dy as isize,
            window.get_selected_tile() as usize,
            9,
        ) {
            window.set_selected_tile(next as i32);
        }
    });
    launcher.show().unwrap();
    render(&launcher_adapter, "a-home-150", 640., 520., 1.5);
    launcher.invoke_focus_input();
    key(launcher.window(), Key::RightArrow);
    key(launcher.window(), Key::DownArrow);
    assert_eq!(
        launcher.get_selected_tile(),
        6,
        "grid navigation must survive the redesign"
    );

    launcher.set_current_query("应用".into());
    launcher.set_results(ModelRc::new(VecModel::from(
        (0..20)
            .map(|index| ResultItem {
                title: format!("应用 {index} — 长名称测试").into(),
                subtitle:
                    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Application.lnk"
                        .into(),
                icon: icon.clone(),
                glyph: "A".into(),
                command_id: format!("app.{index}").into(),
                app: true,
                pinned: false,
                group: "".into(),
            })
            .collect::<Vec<_>>(),
    )));
    render(&launcher_adapter, "a-results-150", 640., 520., 1.5);
    launcher.set_selected_index(19);
    render(&launcher_adapter, "a-results-scrolled", 640., 520., 1.5);
    assert!(
        launcher.get_results_viewport_y() < -500.,
        "last result must scroll into view"
    );
    launcher.set_theme_mode(2);
    render(&launcher_adapter, "a-results-dark", 640., 520., 1.);

    settings.set_texts(settings_texts_for_view(
        cabin_core::settings::Language::ZhCn,
    ));
    settings.set_theme_mode(1);
    settings.set_theme_choice(1);
    settings.set_hotkey_launcher("Alt+Space".into());
    settings.set_hotkey_screenshot("Control+Shift+A".into());
    settings.set_hotkey_delayed("Control+Shift+D".into());
    settings.set_hide_on_blur(true);
    settings.set_max_results("20".into());
    settings.set_history_boost("1.4".into());
    settings.set_app_boost("1.2".into());
    settings.set_file_boost("0.9".into());
    settings.set_plugin_boost("1".into());
    settings.set_favorites(ModelRc::new(VecModel::from(
        titles
            .iter()
            .enumerate()
            .map(|(index, title)| FavoriteRowView {
                title: (*title).into(),
                id: format!("favorite.{index}").into(),
                detail: format!(
                    "应用 · C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\{title}.lnk"
                )
                .into(),
            })
            .collect::<Vec<_>>(),
    )));
    settings.set_about_update_status("已连接 GitHub，当前是最新版本".into());
    settings.show().unwrap();
    for page in 0..5 {
        settings.set_active_page(page);
        render(
            &settings_adapter,
            &format!("a-settings-{page}-150"),
            720.,
            550.,
            1.5,
        );
    }
    settings.set_theme_mode(2);
    settings.set_active_page(2);
    render(&settings_adapter, "a-favorites-dark-200", 680., 500., 2.);
    settings.set_texts(settings_texts_for_view(
        cabin_core::settings::Language::EnUs,
    ));
    settings.set_theme_mode(1);
    settings.set_active_page(1);
    render(&settings_adapter, "a-shortcuts-en-100", 680., 500., 1.);
    // A sidebar click must submit an edited field before destroying its page.
    let committed = Rc::new(RefCell::new(Vec::new()));
    let calls = committed.clone();
    let weak = settings.as_weak();
    settings.on_commit_hotkey(move |field| {
        calls
            .borrow_mut()
            .push((field, weak.unwrap().get_hotkey_launcher().to_string()));
        "Invalid shortcut".into()
    });
    click(settings.window(), 535., 140.);
    key(settings.window(), Key::End);
    settings
        .window()
        .dispatch_event(WindowEvent::KeyPressed { text: "X".into() });
    settings
        .window()
        .dispatch_event(WindowEvent::KeyReleased { text: "X".into() });
    assert!(settings.get_hotkey_launcher().ends_with('X'));
    click(settings.window(), 75., 85.);
    assert_eq!(
        settings.get_active_page(),
        0,
        "sidebar should navigate on click"
    );
    assert!(
        committed
            .borrow()
            .iter()
            .any(|(field, value)| *field == 0 && value.ends_with('X')),
        "leaving a settings page must commit the edited hotkey"
    );
    assert_eq!(
        committed.borrow().len(),
        1,
        "the field must not submit twice"
    );
    assert_eq!(settings.get_error_text(), "Invalid shortcut");

    let mut update = updater_controller::UpdateOrchestration::new(true);
    assert!(update.admit_automatic_check(0));
    assert!(
        update.finish_check_available(cabin_core::updater::UpdateInfo {
            version: "1.0.5".into(),
            notes: None,
            assets: vec![cabin_core::updater::ReleaseAsset {
                name: "CommandCabin-Setup-1.0.5.exe".into(),
                url: "https://github.com/example/setup.exe".into(),
                size: 100,
            }],
        })
    );
    update.begin_download().unwrap();
    update.download_progress(100, 100);
    apply_update_views(
        cabin_core::settings::Language::ZhCn,
        &update.status,
        None,
        Some(&settings),
        Some(&launcher),
    );
    assert!(!launcher.get_update_banner_install());
    assert!(!settings.get_can_install_update());
    update.finish_download();
    assert_install_prompt(
        &launcher,
        &settings,
        &launcher_adapter,
        &settings_adapter,
        &update,
    );
    launcher.hide().unwrap();
    settings.hide().unwrap();
}

fn assert_install_prompt(
    launcher: &LauncherWindow,
    settings: &SettingsWindow,
    launcher_adapter: &MinimalSoftwareWindow,
    settings_adapter: &MinimalSoftwareWindow,
    update: &updater_controller::UpdateOrchestration,
) {
    apply_update_views(
        cabin_core::settings::Language::ZhCn,
        &update.status,
        None,
        Some(settings),
        Some(launcher),
    );
    assert!(launcher.get_update_banner_install());
    assert!(settings.get_can_install_update());
    assert!(!settings.get_can_check_update());
    assert!(launcher
        .get_update_banner_text()
        .contains(update.status.version.as_deref().unwrap()));
    launcher.set_theme_mode(1);
    launcher.set_current_query("test".into());
    let calls = Rc::new(std::cell::Cell::new(0));
    let count = calls.clone();
    launcher.on_install_update(move || count.set(count.get() + 1));
    render(launcher_adapter, "update-ready-search", 640., 520., 1.5);
    click(launcher.window(), 575., 442.);
    assert_eq!(
        calls.get(),
        1,
        "install prompt must be clickable while searching"
    );
    launcher.set_current_query("".into());
    render(launcher_adapter, "update-ready-home", 640., 520., 1.5);
    click(launcher.window(), 575., 442.);
    assert_eq!(
        calls.get(),
        2,
        "install prompt must remain clickable on home"
    );
    settings.set_texts(settings_texts_for_view(
        cabin_core::settings::Language::ZhCn,
    ));
    settings.set_theme_mode(1);
    settings.set_error_text("".into());
    settings.set_active_page(4);
    let count = calls.clone();
    settings.on_install_update(move || count.set(count.get() + 1));
    render(settings_adapter, "update-ready-about", 720., 550., 1.5);
    click(settings.window(), 290., 260.);
    assert_eq!(calls.get(), 3, "About must route its install action too");
}

/// Uses the shipping HTTP client, checksum verifier, state machine and Slint view
/// bindings. Downloads to an isolated probe directory; never executes setup.
#[test]
#[ignore = "downloads the public GitHub release; requires internet"]
fn live_update_download_and_install_prompt() {
    let service = GitHubUpdateService::new();
    let current = std::env::var("CABIN_UPDATE_PROBE_CURRENT").unwrap_or_else(|_| "0.0.0".into());
    let mut update = updater_controller::UpdateOrchestration::new(true);
    assert!(update.admit_automatic_check(0));
    let info = service
        .latest(&current)
        .unwrap()
        .expect("a newer public release");
    if let Ok(expected) = std::env::var("CABIN_UPDATE_PROBE_EXPECTED") {
        assert_eq!(info.version, expected);
    }
    assert!(update.finish_check_available(info));
    let asset = update.begin_download().unwrap();
    let root = std::env::var_os("CABIN_UPDATE_PROBE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("cabin-update-probe-{}", std::process::id()))
        });
    let target = updater_controller::installer_download_path(
        &root,
        update.status.version.as_deref().unwrap(),
    );
    let progress = Arc::new(Mutex::new((0, 0)));
    let progress_copy = progress.clone();
    service
        .download(
            &asset,
            &target,
            Some(Box::new(move |received, total| {
                *progress_copy.lock().unwrap() = (received, total);
            })),
        )
        .expect("real installer download and SHA512 verification");
    let (received, total) = *progress.lock().unwrap();
    assert_eq!(received, asset.size);
    assert_eq!(total, asset.size);
    assert_eq!(std::fs::metadata(&target).unwrap().len(), asset.size);
    update.download_progress(received, total);
    assert!(!update.install_ready());
    update.finish_download();
    assert_eq!(update.install_command(&root).unwrap().program, target);

    let adapters = Rc::new(RefCell::new(Vec::new()));
    slint::platform::set_platform(Box::new(PreviewPlatform(adapters.clone()))).unwrap();
    let launcher = LauncherWindow::new().unwrap();
    let settings = SettingsWindow::new().unwrap();
    push_launcher_texts(&launcher, cabin_core::settings::Language::ZhCn);
    launcher.show().unwrap();
    settings.show().unwrap();
    assert_install_prompt(
        &launcher,
        &settings,
        &adapters.borrow()[0],
        &adapters.borrow()[1],
        &update,
    );
    println!("LIVE UPDATE OK: {} -> {}, {} bytes, verified installer {}, home/search/about install prompts ready",
        current, update.status.version.as_deref().unwrap(), asset.size, target.display());
    launcher.hide().unwrap();
    settings.hide().unwrap();
}
