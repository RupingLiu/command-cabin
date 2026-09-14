//! 平台抽象 trait。cabin-app 只依赖本 crate，平台差异由
//! cabin-platform-windows（未来：macOS / Linux 端口）实现。

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;

use cabin_core::indexer::IndexScanResult;
use cabin_core::screenshot::state::{Point, Rect};
use thiserror::Error;

use crate::accelerator::Accelerator;

// M5 Task 1：更新域类型（ReleaseAsset / UpdateInfo）与 GitHub Releases 响应
// 解析归 cabin_core::updater（core 拥有解析/整形，平台只做 IO——IndexScanResult
// 同款分界）；在此再导出以保持 trait 签名就近可读。
pub use cabin_core::updater::{ReleaseAsset, UpdateInfo};

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("hotkey registration failed: {0}")]
    Hotkey(String),
    #[error("tray unavailable: {0}")]
    Tray(String),
    #[error("launch failed: {0}")]
    Launch(String),
    #[error("single instance check failed: {0}")]
    SingleInstance(String),
    // （M5 收口终裁）原 `Index(String)` 变体已删除：M1 预留至今无任何生产者——
    // AppIndexer::scan 以 IndexScanResult.failures 降级而不返回 Err，M2-M5 各
    // 编排/缓存路径同样未产生索引级 Err。按计划"若届时仍无用途则删除"收口；
    // 索引失败面继续由 IndexScanResult.failures 承载。
    #[error("autostart sync failed: {0}")]
    Autostart(String),
    #[error("icon extraction failed: {0}")]
    Icon(String),
    // M3 Task 4：截图捕获与图片剪贴板写失败路径；Task 5 的 Windows 实现
    // （cabin-platform-windows）是首个生产者。
    #[error("screenshot capture failed: {0}")]
    Capture(String),
    // 剪贴板失败路径：M3 写（copy_png / copy_text）与 M4 读（read_text）共用；
    // 非文本内容不是 Err——它是 Ok(None)（见 ClipboardReader）。
    #[error("clipboard write failed: {0}")]
    Clipboard(String),
    // M3 Task 6：OCR 基础设施失败路径（PNG 解码失败、WinRT 调用失败、轮询超时）。
    // 语言包缺失不是 Err——它是 status=unavailable 的成功结果（对齐 TS JSON 语义）。
    #[error("OCR failed: {0}")]
    Ocr(String),
    // M3 Task 8：保存对话框（IFileSaveDialog）的 COM/线程/接口失败路径。
    // 用户取消不是 Err——它是 Ok(None)（对齐 TS `canceled: true`）。
    #[error("save dialog failed: {0}")]
    SaveDialog(String),
    // M5 Task 1：更新检查失败路径（HTTP 非 2xx / 超时 / 传输失败 / 响应解析
    // 失败 / 版本串非法）。自动检查静默跳过、手动检查直出消息（对齐 TS
    // 更新器失败语义）。消息可读。
    #[error("update check failed: {0}")]
    Update(String),
    // M5 Task 1：更新下载失败路径（边车/资产取数失败、校验不符、尺寸不符、
    // 落盘失败）。安全红线：缺 .sha512 边车或校验失败 → 拒绝并删除临时文件。
    #[error("update download failed: {0}")]
    UpdateDownload(String),
}

/// 登录自启动参数；带该参数启动的实例不显示窗口（对齐 TS launchAtLogin.ts）。
pub const LOGIN_STARTUP_ARG: &str = "--command-cabin-login-startup";

/// argv 是否包含登录启动参数。
pub fn is_login_startup(args: &[String]) -> bool {
    args.iter().any(|arg| arg == LOGIN_STARTUP_ARG)
}

/// 登录自启动开关。Windows 实现直写 HKCU\...\CurrentVersion\Run。
pub trait AutostartManager: Send + Sync {
    fn is_enabled(&self) -> Result<bool, PlatformError>;
    /// enabled=true 写入 "<exe>" <LOGIN_STARTUP_ARG>；false 删除值。
    fn set_enabled(&self, enabled: bool) -> Result<(), PlatformError>;
}

/// 单实例守卫；析构时释放 OS 锁。非主实例进程应立即退出。
pub trait SingleInstance: Send {
    fn is_primary(&self) -> bool;
}

pub trait GlobalHotkeyProvider: Send {
    fn register(
        &self,
        accelerator: &Accelerator,
        handler: Box<dyn Fn() + Send + 'static>,
    ) -> Result<(), PlatformError>;
    /// 注销单个热键（TS `registerGlobalHotkey` 替换语义的注销半步：
    /// 注册新值成功后注销旧值）。未注册的热键返回错误。
    fn unregister(&self, accelerator: &Accelerator) -> Result<(), PlatformError>;
    fn unregister_all(&self) -> Result<(), PlatformError>;
}

/// 托盘菜单事件。`Settings` 变体（M2 Task 10）对齐 TS 托盘菜单的三项结构
/// （show / settings / quit，`trayController.ts` 的 `trayMenuLabels`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayEvent {
    Show,
    Settings,
    Quit,
}

pub trait TrayProvider: Send {
    /// 取走托盘事件 receiver；只能取一次，重复调用返回 None。
    fn take_events(&self) -> Option<Receiver<TrayEvent>>;
}

pub trait AppIndexer: Send + Sync {
    /// 全量扫描。单个条目失败记入 failures，不中断整体（对齐 TS 行为）。
    fn scan(&self) -> IndexScanResult;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchTarget {
    Shortcut(PathBuf),
    Executable {
        path: PathBuf,
        arguments: Option<String>,
        working_directory: Option<PathBuf>,
    },
    Url(String),
    Path(PathBuf),
}

pub trait Launcher: Send + Sync {
    fn open(&self, target: &LaunchTarget) -> Result<(), PlatformError>;
}

/// 一次屏幕捕获中单个显示器的快照：显示器 id、逻辑坐标 `bounds`、DPI 缩放
/// 与该显示器原始（物理像素）尺寸的 PNG 编码。
#[derive(Debug, Clone, PartialEq)]
pub struct DisplaySnapshot {
    pub id: u32,
    pub bounds: Rect,
    /// DPI 缩放方向：physical = logical × scale_factor。
    pub scale_factor: f64,
    pub png: Vec<u8>,
}

/// 一次屏幕捕获的完整结果：各显示器快照与覆盖全部显示器的虚拟桌面
/// 逻辑坐标边界（对齐 cabin-core `calculate_virtual_bounds` 的形状）。
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureResult {
    pub displays: Vec<DisplaySnapshot>,
    pub virtual_bounds: Rect,
}

/// 屏幕捕获。Windows 实现走 GDI（Task 5）。
pub trait ScreenshotCapture: Send + Sync {
    /// 捕获活动显示器（或全部）原始尺寸 PNG；失败 PlatformError::Capture（新变体）。
    /// `active_point`（逻辑坐标）用于定位光标所在显示器；None 时捕获全部显示器。
    fn capture_displays(&self, active_point: Option<Point>)
        -> Result<CaptureResult, PlatformError>;
}

/// 剪贴板写入：PNG 图片与纯文本。Windows 实现走 Win32 剪贴板（Task 5）。
pub trait ImageClipboard: Send + Sync {
    fn copy_png(&self, png: Vec<u8>) -> Result<(), PlatformError>;
    fn copy_text(&self, text: String) -> Result<(), PlatformError>;
}

/// 剪贴板纯文本读取（M4 剪贴板历史轮询器）。Windows 实现走 arboard（Task 3）。
///
/// `None` = 非文本内容（如仅图片）或剪贴板无文本格式。TS 侧 Electron
/// `clipboard.readText()` 对非文本返回 `''`、watcher 归一化后按空串跳过；
/// Rust 侧把该情形显式建模为 `Ok(None)`，与 `Some("")`（真·空文本）一起由
/// watcher 的空值短路跳过——两种表示最终行为一致。读失败（剪贴板被占用等，
/// TS readText 抛错 → onError）仍走 `Err(PlatformError::Clipboard)`。
pub trait ClipboardReader: Send {
    fn read_text(&self) -> Result<Option<String>, PlatformError>;
}

/// 自更新服务（M5）。Windows 实现走 GitHub Releases
/// （cabin-platform-windows `updater`）；调用方（cabin-app，Task 3）只面向
/// 本 trait。
pub trait UpdateService: Send + Sync {
    /// 查最新发布信息。`latest` 版本不新于 `current_version` → `Ok(None)`
    ///（对齐 TS `update-not-available`）；有更新 → `Ok(Some(info))`（info 只
    /// 是清单，不隐含任何已下载状态）。网络 / 解析失败 →
    /// `PlatformError::Update`（消息可读；自动检查方负责静默）。
    fn latest(&self, current_version: &str) -> Result<Option<UpdateInfo>, PlatformError>;
    /// 流式下载资产到 `to`（可选进度回调，参数 = (已下载字节, 总字节)）。
    ///
    /// 下载走临时文件（`<to>.<pid>.<seq>.tmp`，icons/exchange-rate 原子写
    /// 同款）+ sha512 校验（资产同名 `.sha512` 边车）后 rename 成品；校验
    /// 失败 / 边车缺失 → 删除临时文件并返回 `PlatformError::UpdateDownload`
    /// （**安全红线：无校验文件绝不落盘成品**）。下载在调用线程同步执行
    /// （Task 3 负责放入工作线程）；中途进程退出遗留的临时文件由 Task 3
    /// 编排在下次启动时清理。
    fn download(
        &self,
        asset: &ReleaseAsset,
        to: &Path,
        progress: Option<Box<dyn Fn(u64, u64) + Send>>,
    ) -> Result<(), PlatformError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_login_startup_arg() {
        let args = vec![
            "command-cabin.exe".to_string(),
            LOGIN_STARTUP_ARG.to_string(),
        ];
        assert!(is_login_startup(&args));
    }

    #[test]
    fn missing_login_startup_arg_is_false() {
        let args = vec!["command-cabin.exe".to_string(), "--other".to_string()];
        assert!(!is_login_startup(&args));
        assert!(!is_login_startup(&[]));
    }

    #[test]
    fn substring_match_is_false() {
        let args = vec![
            format!("x{LOGIN_STARTUP_ARG}"),
            format!("{LOGIN_STARTUP_ARG}=1"),
        ];
        assert!(!is_login_startup(&args));
    }

    #[test]
    fn autostart_error_variant_formats() {
        let err = PlatformError::Autostart("io".into());
        assert_eq!(err.to_string(), "autostart sync failed: io");
    }

    #[test]
    fn update_error_variants_format() {
        let err = PlatformError::Update("HTTP 403".into());
        assert_eq!(err.to_string(), "update check failed: HTTP 403");
        let err = PlatformError::UpdateDownload("checksum mismatch".into());
        assert_eq!(err.to_string(), "update download failed: checksum mismatch");
    }

    /// M5 Task 1：更新服务 trait 的对象安全 / Send+Sync / 决策路由。
    #[test]
    fn update_service_trait_object_routes() {
        use std::sync::Mutex;

        struct StaticService;

        impl UpdateService for StaticService {
            fn latest(&self, current_version: &str) -> Result<Option<UpdateInfo>, PlatformError> {
                let info = UpdateInfo {
                    version: "1.1.0".to_string(),
                    notes: Some("notes".to_string()),
                    assets: Vec::new(),
                };
                if cabin_core::updater::is_newer(&info.version, current_version)
                    .map_err(|error| PlatformError::Update(error.to_string()))?
                {
                    Ok(Some(info))
                } else {
                    Ok(None)
                }
            }

            fn download(
                &self,
                asset: &ReleaseAsset,
                to: &Path,
                progress: Option<Box<dyn Fn(u64, u64) + Send>>,
            ) -> Result<(), PlatformError> {
                if let Some(progress) = progress {
                    progress(asset.size, asset.size);
                }
                std::fs::write(to, b"payload")
                    .map_err(|error| PlatformError::UpdateDownload(error.to_string()))
            }
        }

        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn UpdateService>>();

        let service: Box<dyn UpdateService> = Box::new(StaticService);
        assert_eq!(
            service.latest("1.0.0").unwrap().map(|info| info.version),
            Some("1.1.0".to_string())
        );
        assert_eq!(service.latest("1.1.0").unwrap(), None);

        let calls: std::sync::Arc<Mutex<Vec<(u64, u64)>>> = Default::default();
        {
            let calls = calls.clone();
            let progress: Box<dyn Fn(u64, u64) + Send> =
                Box::new(move |done, total| calls.lock().unwrap().push((done, total)));
            let asset = ReleaseAsset {
                name: "CommandCabin-Setup-1.1.0.exe".to_string(),
                url: "https://example.com/x.exe".to_string(),
                size: 7,
            };
            let to = std::env::temp_dir()
                .join(format!("cabin-platform-trait-{}.exe", std::process::id()));
            service
                .download(&asset, &to, Some(progress))
                .expect("download ok");
            assert_eq!(std::fs::read(&to).unwrap(), b"payload");
            let _ = std::fs::remove_file(&to);
        }
        assert_eq!(*calls.lock().unwrap(), vec![(7, 7)]);

        // Err 路径透传变体与消息。
        struct FailingService;

        impl UpdateService for FailingService {
            fn latest(&self, _current_version: &str) -> Result<Option<UpdateInfo>, PlatformError> {
                Err(PlatformError::Update("HTTP 500".into()))
            }

            fn download(
                &self,
                _asset: &ReleaseAsset,
                _to: &Path,
                _progress: Option<Box<dyn Fn(u64, u64) + Send>>,
            ) -> Result<(), PlatformError> {
                Err(PlatformError::UpdateDownload(
                    "sha512 sidecar missing".into(),
                ))
            }
        }

        let failing: Box<dyn UpdateService> = Box::new(FailingService);
        assert_eq!(
            failing.latest("1.0.0").unwrap_err().to_string(),
            "update check failed: HTTP 500"
        );
        assert_eq!(
            failing
                .download(
                    &ReleaseAsset {
                        name: "x".to_string(),
                        url: "https://example.com/x".to_string(),
                        size: 1
                    },
                    Path::new("unused"),
                    None
                )
                .unwrap_err()
                .to_string(),
            "update download failed: sha512 sidecar missing"
        );
    }

    #[test]
    fn capture_error_variant_formats() {
        let err = PlatformError::Capture("gdi".into());
        assert_eq!(err.to_string(), "screenshot capture failed: gdi");
    }

    #[test]
    fn clipboard_error_variant_formats() {
        let err = PlatformError::Clipboard("open".into());
        assert_eq!(err.to_string(), "clipboard write failed: open");
    }

    struct FixedCapture;

    impl ScreenshotCapture for FixedCapture {
        fn capture_displays(
            &self,
            active_point: Option<Point>,
        ) -> Result<CaptureResult, PlatformError> {
            assert_eq!(active_point, Some(Point { x: 10.0, y: 20.0 }));
            Ok(CaptureResult {
                displays: vec![DisplaySnapshot {
                    id: 1,
                    bounds: Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 100.0,
                        height: 80.0,
                    },
                    scale_factor: 1.5,
                    png: vec![0x89, b'P', b'N', b'G'],
                }],
                virtual_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 80.0,
                },
            })
        }
    }

    #[test]
    fn capture_trait_object_routes_to_implementation() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn ScreenshotCapture>>();

        let capture: Box<dyn ScreenshotCapture> = Box::new(FixedCapture);
        let result = capture
            .capture_displays(Some(Point { x: 10.0, y: 20.0 }))
            .expect("capture succeeds");

        assert_eq!(result.displays.len(), 1);
        let display = &result.displays[0];
        assert_eq!(display.id, 1);
        assert_eq!(display.scale_factor, 1.5);
        assert_eq!(display.png, vec![0x89, b'P', b'N', b'G']);
        assert_eq!(result.virtual_bounds.width, 100.0);
        assert_eq!(result.virtual_bounds.height, 80.0);

        // 失败路径按 PlatformError 透传。
        struct FailingCapture;

        impl ScreenshotCapture for FailingCapture {
            fn capture_displays(
                &self,
                _active_point: Option<Point>,
            ) -> Result<CaptureResult, PlatformError> {
                Err(PlatformError::Capture("no displays".into()))
            }
        }

        let failing: Box<dyn ScreenshotCapture> = Box::new(FailingCapture);
        let err = failing
            .capture_displays(None)
            .expect_err("capture fails")
            .to_string();
        assert_eq!(err, "screenshot capture failed: no displays");
    }

    #[test]
    fn clipboard_trait_object_records_writes() {
        use std::sync::Mutex;

        struct RecordingClipboard {
            calls: Mutex<Vec<String>>,
        }

        impl ImageClipboard for RecordingClipboard {
            fn copy_png(&self, png: Vec<u8>) -> Result<(), PlatformError> {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push(format!("png:{}", png.len()));
                Ok(())
            }

            fn copy_text(&self, text: String) -> Result<(), PlatformError> {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push(format!("text:{text}"));
                Ok(())
            }
        }

        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Box<dyn ImageClipboard>>();

        let clipboard = RecordingClipboard {
            calls: Mutex::new(Vec::new()),
        };
        let as_trait: &dyn ImageClipboard = &clipboard;
        as_trait.copy_png(vec![1, 2, 3]).expect("png write");
        as_trait.copy_text("hello".to_string()).expect("text write");

        assert_eq!(
            *clipboard.calls.lock().expect("calls lock"),
            vec!["png:3".to_string(), "text:hello".to_string()]
        );
    }

    /// M4 Task 3：读侧 trait 的对象安全 / Send / 三路返回值（Some / None / Err）路由。
    #[test]
    fn clipboard_reader_trait_object_routes_reads() {
        struct StaticReader;

        impl ClipboardReader for StaticReader {
            fn read_text(&self) -> Result<Option<String>, PlatformError> {
                Ok(Some("hello".to_string()))
            }
        }

        struct NonTextReader;

        impl ClipboardReader for NonTextReader {
            fn read_text(&self) -> Result<Option<String>, PlatformError> {
                Ok(None)
            }
        }

        struct FailingReader;

        impl ClipboardReader for FailingReader {
            fn read_text(&self) -> Result<Option<String>, PlatformError> {
                Err(PlatformError::Clipboard("occupied".into()))
            }
        }

        fn assert_send<T: Send>() {}
        assert_send::<Box<dyn ClipboardReader>>();

        let reader: Box<dyn ClipboardReader> = Box::new(StaticReader);
        assert_eq!(
            reader.read_text().expect("read succeeds"),
            Some("hello".to_string())
        );

        let reader: Box<dyn ClipboardReader> = Box::new(NonTextReader);
        assert_eq!(reader.read_text().expect("read succeeds"), None);

        let reader: Box<dyn ClipboardReader> = Box::new(FailingReader);
        let err = reader.read_text().expect_err("read fails").to_string();
        assert_eq!(err, "clipboard write failed: occupied");
    }
}
