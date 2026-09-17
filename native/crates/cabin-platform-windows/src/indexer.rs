//! Windows 开始菜单/桌面 .lnk 索引器：递归扫描后经 IShellLinkW COM 解析。
//! 对齐 TS packages/core/src/indexer/windows/startMenuScanner.ts 的扫描根目录与
//! “单条失败不中断”行为；COM 解析取代 TS 版的 PowerShell 子进程。

use std::path::{Path, PathBuf};

use cabin_core::indexer::{IndexScanFailure, IndexScanResult, IndexedShortcut};
use cabin_platform::traits::AppIndexer;
use windows::core::{Interface, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

/// 扫描开始菜单（ProgramData/AppData）与用户/公共桌面下递归的 *.lnk。
pub struct WindowsStartMenuIndexer {
    roots: Vec<PathBuf>,
}

impl WindowsStartMenuIndexer {
    pub fn new() -> Self {
        let mut roots = Vec::new();
        if let Ok(program_data) = std::env::var("ProgramData") {
            roots.push(PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Ok(app_data) = std::env::var("AppData") {
            roots.push(PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Ok(user_profile) = std::env::var("UserProfile") {
            roots.push(PathBuf::from(user_profile).join("Desktop"));
        }
        if let Ok(public) = std::env::var("Public") {
            roots.push(PathBuf::from(public).join("Desktop"));
        }
        Self { roots }
    }

    /// 测试/自定义根目录构造。
    pub fn with_roots(roots: Vec<PathBuf>) -> Self {
        Self { roots }
    }
}

impl Default for WindowsStartMenuIndexer {
    fn default() -> Self {
        Self::new()
    }
}

impl AppIndexer for WindowsStartMenuIndexer {
    fn scan(&self) -> IndexScanResult {
        let mut result = IndexScanResult::default();
        // 每次 scan 在当前线程初始化一次 COM 套间，避免按文件重复 init/uninit。
        let _com = ComApartment::init();
        for root in &self.roots {
            scan_directory(root, &mut result);
        }
        result
    }
}

/// RAII 守卫：仅当 CoInitializeEx 成功（S_OK/S_FALSE）时持有，
/// Drop 时配对 CoUninitialize；RPC_E_CHANGED_MODE 等情况不做 uninit。
struct ComApartment;

impl ComApartment {
    fn init() -> Option<Self> {
        // SAFETY: COM 单线程套间初始化；失败（如已按其他模型初始化）时返回 None。
        // 返回 HRESULT：S_OK/S_FALSE 均为 is_ok()，均需配对 CoUninitialize。
        if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok() {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        // SAFETY: 与 init 中成功的 CoInitializeEx 配对。
        unsafe { CoUninitialize() };
    }
}

fn scan_directory(dir: &Path, result: &mut IndexScanResult) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // 目录不可读不是致命错误，跳过并继续。注意：TS 会把这类失败记入 failures，
        // 此处未记录（对齐差距，M2 补诊断日志时一并处理）。
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_directory(&path, result);
        } else if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
        {
            match resolve_shortcut(&path) {
                Ok(shortcut) => result.shortcuts.push(shortcut),
                Err(message) => result.failures.push(IndexScanFailure {
                    path: path.clone(),
                    message,
                }),
            }
        }
    }
}

fn resolve_shortcut(path: &Path) -> Result<IndexedShortcut, String> {
    let name = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default()
        .to_string();

    let (target_path, arguments, working_directory, icon_path) = {
        // SAFETY: ShellLink 为进程内 COM 组件；link/persist 在本作用域末尾 drop（Release），
        // 早于 scan() 持有的 ComApartment 守卫析构，释放顺序正确。
        let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| format!("CoCreateInstance failed: {e}"))?;
        let persist: IPersistFile = link.cast().map_err(|e| format!("cast failed: {e}"))?;
        let wide: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: wide 以 NUL 结尾，指针在调用期间有效。
        unsafe { persist.Load(PCWSTR(wide.as_ptr()), STGM_READ) }
            .map_err(|e| format!("IPersistFile::Load failed: {e}"))?;

        // SAFETY: read_link_string 传入的 buffer 长度满足各 Get* 的写入上界。
        let target_path =
            read_link_string(|buf| unsafe { link.GetPath(buf, std::ptr::null_mut(), 0) })
                .map(PathBuf::from);
        // SAFETY: 同上。
        let arguments = read_link_string(|buf| unsafe { link.GetArguments(buf) });
        // SAFETY: 同上。
        let working_directory =
            read_link_string(|buf| unsafe { link.GetWorkingDirectory(buf) }).map(PathBuf::from);
        let mut icon_index = 0i32;
        // SAFETY: 同上；icon_index 为有效 out 指针。
        let icon_path =
            read_link_string(|buf| unsafe { link.GetIconLocation(buf, &mut icon_index) });
        // M2 注意：icon_index（",N" 后缀）当前被丢弃，且未移植 TS 的 isUsefulIconPath
        // 过滤；M2 图标解析需要非零索引时在此补齐。
        (target_path, arguments, working_directory, icon_path)
    };

    Ok(IndexedShortcut {
        shortcut_path: path.to_path_buf(),
        name,
        target_path,
        arguments,
        working_directory,
        app_user_model_id: None, // AUMID 经 IPropertyStore 读取，M2 随图标解析一起补齐
        icon_path,
    })
}

/// 读取 COM 输出缓冲区（NUL 结尾宽字符）为 String；空串或调用失败视为 None。
fn read_link_string(f: impl FnOnce(&mut [u16]) -> windows::core::Result<()>) -> Option<String> {
    const SIZE: usize = 1024;
    let mut buffer = vec![0u16; SIZE];
    f(&mut buffer).ok()?;
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(SIZE);
    if end == 0 {
        return None;
    }
    String::from_utf16(&buffer[..end]).ok()
}

#[cfg(all(test, windows))]
fn create_test_lnk(link_path: &Path, target: &str) {
    unsafe {
        let _com = ComApartment::init();
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
        let wide_target: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
        link.SetPath(PCWSTR(wide_target.as_ptr())).unwrap();
        let persist: IPersistFile = link.cast().unwrap();
        let wide_link: Vec<u16> = link_path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        persist.Save(PCWSTR(wide_link.as_ptr()), true).unwrap();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use cabin_platform::traits::AppIndexer;

    /// 目录守卫：断言失败 panic 时也清理临时目录。
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn create(name: &str) -> Self {
            let dir = std::env::temp_dir().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    #[test]
    fn resolves_lnk_created_via_com() {
        let dir = TempDir::create("cabin-indexer-test");
        let lnk = dir.0.join("cabin-test.lnk");
        create_test_lnk(&lnk, r"C:\Windows\System32\notepad.exe");
        let indexer = WindowsStartMenuIndexer::with_roots(vec![dir.0.clone()]);
        let result = indexer.scan();
        let entry = result
            .shortcuts
            .iter()
            .find(|s| s.shortcut_path == lnk)
            .expect("lnk should be discovered");
        assert_eq!(entry.name, "cabin-test");
        assert!(entry
            .target_path
            .as_ref()
            .is_some_and(|p| p.to_string_lossy().to_lowercase().contains("notepad.exe")));
    }

    #[test]
    fn rescanning_discovers_new_install_and_removes_deleted_shortcuts() {
        use cabin_core::indexer::app_commands::{commands_from_shortcuts, merge_app_commands};
        use cabin_core::search::engine::{SearchEngine, SearchOptions};

        let dir = TempDir::create("cabin-indexer-refresh-test");
        let desktop = dir.0.join("Desktop");
        let programs = dir.0.join("Programs");
        std::fs::create_dir_all(&desktop).unwrap();
        std::fs::create_dir_all(&programs).unwrap();
        let indexer = WindowsStartMenuIndexer::with_roots(vec![programs.clone(), desktop.clone()]);
        create_test_lnk(&programs.join("Editor.lnk"), r"C:\Apps\Editor\Editor.exe");
        let mut engine = SearchEngine::new(commands_from_shortcuts(&indexer.scan().shortcuts));
        assert!(engine
            .search("Editor Code", SearchOptions::default())
            .iter()
            .all(|item| item.command.title != "Editor Code"));

        // Reproduce installing a similarly named app while the launcher is resident.
        let target = r"C:\Apps\Editor Code\Editor Code.exe";
        let desktop_link = desktop.join("Editor Code.lnk");
        let menu_link = programs.join("Editor Code.lnk");
        create_test_lnk(&desktop_link, target);
        create_test_lnk(&menu_link, target);
        let scan = indexer.scan();
        assert!(scan.failures.is_empty());
        engine.update(merge_app_commands(
            commands_from_shortcuts(&scan.shortcuts),
            vec![],
        ));
        let found = engine.search("editor code", SearchOptions::default());
        assert_eq!(
            found
                .iter()
                .filter(|item| item.command.title == "Editor Code")
                .count(),
            1
        );
        assert_eq!(found[0].command.title, "Editor Code");
        assert_eq!(found[0].command.action.payload["executablePath"], target);

        std::fs::remove_file(desktop_link).unwrap();
        std::fs::remove_file(menu_link).unwrap();
        engine.update(commands_from_shortcuts(&indexer.scan().shortcuts));
        assert!(engine
            .search("editor code", SearchOptions::default())
            .iter()
            .all(|item| item.command.title != "Editor Code"));
    }

    /// Explicit local probe; no application is launched and no user data is changed.
    #[test]
    #[ignore = "requires CABIN_INDEX_PROBE_QUERY and installed Windows shortcuts"]
    fn installed_app_is_searchable() {
        use cabin_core::indexer::app_commands::{commands_from_shortcuts, merge_app_commands};
        use cabin_core::search::engine::{SearchEngine, SearchOptions};

        let query = std::env::var("CABIN_INDEX_PROBE_QUERY").expect("set CABIN_INDEX_PROBE_QUERY");
        let scan = WindowsStartMenuIndexer::new().scan();
        let commands = merge_app_commands(commands_from_shortcuts(&scan.shortcuts), vec![]);
        let engine = SearchEngine::new(commands);
        let found = engine.search(&query, SearchOptions::default());
        let exact: Vec<_> = found
            .iter()
            .filter(|item| item.command.title.eq_ignore_ascii_case(&query))
            .collect();
        assert_eq!(
            exact.len(),
            1,
            "expected one deduplicated match for {query}"
        );
        let command = &exact[0].command;
        let target = command.action.payload["executablePath"]
            .as_str()
            .expect("executable path");
        assert!(Path::new(target).is_file(), "target must exist: {target}");
        assert_eq!(
            found[0].command.id, command.id,
            "exact title should rank first"
        );
        println!("Verified: {} -> {target}", command.title);
    }
}
