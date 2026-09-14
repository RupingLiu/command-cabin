//! Windows 图标提取：全程进程内完成，无 PowerShell 子进程。
//!
//! 行为对齐 TS `apps/desktop/src/main/icons/*`，机制替换为原生 API：
//! - 一般路径（exe/com/lnk/图片文件/shell:AppsFolder 项）：`SHCreateItemFromParsingName`
//!   → `IShellItemImageFactory::GetImage`（`SIIGBF_BIGGERSIZEOK`）→ HBITMAP → GDI+ PNG。
//!   不带 `SIIGBF_ICONONLY`，因此图片文件（TS IMAGE_FILE_EXTENSIONS：ico/jpg/jpeg/png/webp）
//!   走同一条管线时由 WIC/缩略图处理器直接解码为内容本身，exe/lnk 则返回图标——
//!   与 TS "图片文件直读内容、其余 getFileIcon" 的行为一致；webp 依赖系统已装解码器。
//! - ",N" 后缀：剥离后 `SHDefExtractIconW` 取 HICON → `GdipCreateBitmapFromHICON`
//!   （等价 DrawIconEx 到位图，且正确处理旧式掩码图标 alpha）→ PNG。
//! - AUMID：先经 `shell:AppsFolder\{AUMID}` 项渲染；失败则用 kernel32
//!   `GetPackagesByPackageFamily`/`GetPackagePathByFullName` 取安装目录（进程内，
//!   取代 TS 的 PowerShell `Get-AppxPackage`），探测 AppxManifest logo 资产。
//!   计划允许用 WinRT `Windows.Management.Deployment.PackageManager`；本实现选用
//!   语义等价、更轻量的 kernel32 API（同样枚举当前用户已注册包）。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use cabin_platform::traits::PlatformError;
use windows::core::{Interface, GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, SIZE};
use windows::Win32::Graphics::Gdi::{
    BITMAP, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits,
    GetObjectW, HBITMAP, HGDIOBJ, ReleaseDC,
};
use windows::Win32::Graphics::GdiPlus::{
    BitmapData, GdipBitmapLockBits, GdipBitmapUnlockBits, GdipCreateBitmapFromHICON,
    GdipCreateBitmapFromScan0, GdipDisposeImage, GdipSaveImageToStream, GdiplusStartup,
    GdiplusStartupInput, GpBitmap, GpImage, Rect, Status,
};

/// GDI+ 像素格式 PixelFormat32bppARGB（0x26200A：32bpp、每通道 8 位、含 alpha）。
/// windows crate 的 GdiPlus 模块未导出该常量，按 wingdi.h 文档化值定义。
const PIXEL_FORMAT_32BPP_ARGB: i32 = 0x26200A;
/// GDI+ ImageLockModeWrite（gdiplusimaging.h）。
const IMAGE_LOCK_MODE_WRITE: u32 = 2;
use windows::Win32::Storage::Packaging::Appx::{
    GetPackagePathByFullName, GetPackagesByPackageFamily,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, IBindCtx, ISequentialStream, IStream, COINIT_MULTITHREADED,
    STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SHCreateMemStream, SHDefExtractIconW,
    SIIGBF_BIGGERSIZEOK,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, HICON};

/// GDI+ 成功状态码（模块级常量 `Ok` 即 Status(0)）。
const GDIPLUS_OK: Status = windows::Win32::Graphics::GdiPlus::Ok;

/// TS appIconResolver.ts `PACKAGED_APP_ASSET_PATHS` 逐字移植（13 条，
/// 相对包安装根目录；Electron 打包应用的常见图标资产位置）。
const PACKAGED_APP_ASSET_PATHS: &[&[&str]] = &[
    &["resources", "logo.ico"],
    &["resources", "logo.png"],
    &["resources", "icon.ico"],
    &["resources", "icon.png"],
    &["resources", "app.ico"],
    &["resources", "app.png"],
    &["resources", "app", "static", "logo-256x256.png"],
    &["resources", "app", "static", "icon-logo.ico"],
    &["resources", "app", "static", "icon.png"],
    &["resources", "app", "build", "icon.ico"],
    &["resources", "app", "assets", "icon.png"],
    &["resources", "app", "icon.png"],
    &["resources", "app", "icon.ico"],
];

/// TS windowsAppUserModelIconResolver.ts 的 targetsize 后缀（逐字移植，含顺序）。
const TARGETSIZE_SUFFIXES: &[&str] = &[
    ".targetsize-256",
    ".targetsize-128",
    ".targetsize-96",
    ".targetsize-64",
    ".targetsize-48",
];

/// TS windowsAppUserModelIconResolver.ts 的 scale 后缀（逐字移植，含顺序）。
const SCALE_SUFFIXES: &[&str] = &[".scale-400", ".scale-200", ".scale-150", ".scale-100"];

/// GDI+ 内置 PNG 编码器 CLSID（{557CF406-1A04-11D3-9A73-0000F81EF32E}，
/// 自 GDI+ 1.0 起稳定的文档化值）。
const PNG_ENCODER_CLSID: GUID = GUID::from_values(
    0x557C_F406,
    0x1A04,
    0x11D3,
    [0x9A, 0x73, 0x00, 0x00, 0xF8, 0x1E, 0xF3, 0x2E],
);

/// PNG 流尺寸上限（256px 图标 PNG 通常 <100KB；16MiB 足够宽裕且防异常输出撑爆内存）。
const MAX_PNG_BYTES: u64 = 16 * 1024 * 1024;

/// TS ICON_INDEX_SUFFIX_PATTERN /,\d+$/ 的等价剥离 + 解析。
/// 返回 (去掉索引的路径, 图标索引)。
fn split_icon_index_suffix(input: &str) -> Result<(String, Option<u32>), PlatformError> {
    if let Some(comma) = input.rfind(',') {
        let digits = &input[comma + 1..];
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            let base = &input[..comma];
            if base.trim().is_empty() {
                // TS ICON_INDEX_ONLY_PATTERN：形如 ",0" 的孤立索引是无效候选。
                return Err(PlatformError::Icon(format!(
                    "icon index without a path: {input:?}"
                )));
            }
            // 超长数字按 i32 上限截断（正则语义下任何位数都会被剥离）。
            let index = digits
                .parse::<u64>()
                .map_or(i32::MAX as u64, |v| v.min(i32::MAX as u64)) as u32;
            return Ok((base.to_string(), Some(index)));
        }
    }
    Ok((input.to_string(), None))
}

/// TS isAppUserModelIdCandidate：含 '!' 且不含路径分隔符的候选视为 AUMID。
fn looks_like_aumid(input: &str) -> bool {
    is_valid_aumid(input)
}

/// TS isValidAppUserModelId：'!' 分隔且两段非空，无 '\\'/'/'。
fn is_valid_aumid(aumid: &str) -> bool {
    match aumid.split_once('!') {
        Some((family, application)) => {
            !family.is_empty()
                && !application.is_empty()
                && !aumid.contains('\\')
                && !aumid.contains('/')
        }
        None => false,
    }
}

/// 识别 `shell:AppsFolder\{AUMID}` / `shell:AppsFolder/{AUMID}` 前缀（大小写不敏感）。
fn strip_shell_apps_folder_prefix(input: &str) -> Option<&str> {
    const PREFIX: &str = "shell:AppsFolder";
    // get(..n) 而非切片：非字符边界（多字节输入）时返回 None 而非 panic。
    let head = input.get(..PREFIX.len())?;
    if head.eq_ignore_ascii_case(PREFIX) {
        let rest = &input[PREFIX.len()..];
        let rest = rest.strip_prefix('\\').or_else(|| rest.strip_prefix('/'))?;
        let rest = rest.trim();
        if !rest.is_empty() {
            return Some(rest);
        }
    }
    None
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// TS expandEnvironmentVariables：%VAR% 展开失败时原样返回（与 TS 一致）。
fn expand_environment_variables(path: &str) -> String {
    if !path.contains('%') {
        return path.to_string();
    }
    let src = to_wide(path);
    // SAFETY: src 为有效的 NUL 结尾宽字符串；第二参数 None 仅查询所需长度。
    let required = unsafe { ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), None) };
    if required == 0 {
        return path.to_string();
    }
    let mut buffer = vec![0u16; required as usize];
    // SAFETY: buffer 长度与查询到的 required（含 NUL）一致。
    let written = unsafe { ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut buffer)) };
    if written == 0 || written as usize > buffer.len() {
        return path.to_string();
    }
    let end = (written as usize - 1).min(buffer.len()); // written 含结尾 NUL
    String::from_utf16_lossy(&buffer[..end])
}

/// 从任意路径/shell:AppsFolder 项提取 size×size PNG 字节。
/// 路径支持 ",N" 图标索引后缀；exe/com/lnk/图片文件/shell:AppsFolder\AUMID；
/// 裸 AUMID（含 '!' 且无路径分隔符）亦路由到 AUMID 解析（对齐 TS 候选判定）。
/// 失败返回 `PlatformError::Icon`。
pub fn extract_icon_png(path_or_shell_item: &str, size: u32) -> Result<Vec<u8>, PlatformError> {
    if size == 0 {
        return Err(PlatformError::Icon("size must be positive".to_string()));
    }
    let input = path_or_shell_item.trim();
    if input.is_empty() {
        return Err(PlatformError::Icon("empty icon path".to_string()));
    }
    if let Some(aumid) = strip_shell_apps_folder_prefix(input) {
        return extract_aumid_icon_png(aumid, size);
    }
    if looks_like_aumid(input) {
        return extract_aumid_icon_png(input, size);
    }
    let (base_path, icon_index) = split_icon_index_suffix(input)?;
    let base_path = expand_environment_variables(&base_path);
    match icon_index {
        Some(index) => extract_by_icon_index(&base_path, index, size),
        None => extract_via_shell_item(&base_path, size),
    }
}

/// 仅解析 AUMID 的展示图标：先 `shell:AppsFolder\{AUMID}` 经
/// `IShellItemImageFactory`，失败再回退 AppxManifest 资产探测。
pub fn extract_aumid_icon_png(aumid: &str, size: u32) -> Result<Vec<u8>, PlatformError> {
    if size == 0 {
        return Err(PlatformError::Icon("size must be positive".to_string()));
    }
    let aumid = aumid.trim();
    if !is_valid_aumid(aumid) {
        return Err(PlatformError::Icon(format!(
            "invalid AppUserModelID: {aumid:?}"
        )));
    }
    // 主路径：AppsFolder 命名空间项（SHCreateItemFromParsingName 支持 shell: 解析名）。
    if let Ok(png) = extract_via_shell_item(&format!("shell:AppsFolder\\{aumid}"), size) {
        return Ok(png);
    }
    // 回退：包安装目录 AppxManifest 资产探测（对齐 TS windowsAppUserModelIconResolver）。
    resolve_aumid_from_manifest(aumid, size)
}

/// 一般路径：shell 项 → GetImage → HBITMAP → PNG。
fn extract_via_shell_item(path: &str, size: u32) -> Result<Vec<u8>, PlatformError> {
    let _com = ComApartment::init();
    let wide = HSTRING::from(path);
    // SAFETY: wide 为本帧内有效的 NUL 结尾宽字符串；返回的 COM 对象由 RAII 释放。
    let factory: IShellItemImageFactory =
        unsafe { SHCreateItemFromParsingName(&wide, None::<&IBindCtx>) }.map_err(|e| {
            PlatformError::Icon(format!("SHCreateItemFromParsingName({path:?}) failed: {e}"))
        })?;
    // 不带 SIIGBF_ICONONLY：图片文件得到内容缩略图，exe/lnk 得到图标（见模块注释）。
    let get_image = unsafe {
        factory.GetImage(
            SIZE {
                cx: size as i32,
                cy: size as i32,
            },
            SIIGBF_BIGGERSIZEOK,
        )
    };
    let hbitmap = get_image.map_err(|e| {
        PlatformError::Icon(format!(
            "IShellItemImageFactory::GetImage({path:?}) failed: {e}"
        ))
    })?;
    let png = encode_hbitmap_to_png(hbitmap, path);
    // SAFETY: hbitmap 为 GetImage 返回的 GDI 对象，编码结束（无论成败）后删除。
    let _ = unsafe { DeleteObject(HGDIOBJ(hbitmap.0)) };
    png
}

/// ",N" 后缀路径：SHDefExtractIconW 取 HICON → PNG。
fn extract_by_icon_index(base_path: &str, index: u32, size: u32) -> Result<Vec<u8>, PlatformError> {
    let _com = ComApartment::init();
    let wide = HSTRING::from(base_path);
    let icon_size = size | (size << 16); // LOWORD = 大图标边长，HIWORD = 小图标边长
                                         // ".lnk" IconLocation 的 ",N" 语义是文件内零基图标序号，对应 SHDefExtractIconW
                                         // 的正数 iIndex；负数 iIndex 表示按资源 ID（|iIndex|）提取。计划文本写作 -index；
                                         // 此处先按零基索引提取，失败再按资源 ID 兜底，两者皆败最后回退常规 shell 项
                                         // 路径（等价 TS 丢弃索引、取默认图标的行为）。
    let mut candidates = vec![index as i32];
    if index != 0 {
        candidates.push(-(index as i32));
    }
    let mut hicon = HICON::default();
    let mut extracted = false;
    for candidate_index in candidates {
        // SAFETY: wide 为有效的 NUL 结尾宽字符串；hicon 为有效出参。
        let result = unsafe {
            SHDefExtractIconW(&wide, candidate_index, 0, Some(&mut hicon), None, icon_size)
        };
        if result.is_ok() && !hicon.0.is_null() {
            extracted = true;
            break;
        }
        hicon = HICON::default();
    }
    if !extracted {
        return extract_via_shell_item(base_path, size);
    }
    let png = encode_hicon_to_png(hicon, base_path);
    // SAFETY: hicon 由 SHDefExtractIconW 成功创建，编码结束（无论成败）后销毁。
    let _ = unsafe { DestroyIcon(hicon) };
    png
}

/// AUMID 回退：kernel32 枚举 family 的注册包（当前用户）→ 首个包的安装目录。
fn get_package_install_location(family: &str) -> Result<PathBuf, PlatformError> {
    let family_wide = to_wide(family);
    let mut count = 0u32;
    let mut buffer_len = 0u32;
    // SAFETY: 首次调用以 None 查询 full name 个数与缓冲区长度（文档化两次调用模式）。
    let probe = unsafe {
        GetPackagesByPackageFamily(
            PCWSTR(family_wide.as_ptr()),
            &mut count,
            None,
            &mut buffer_len,
            None,
        )
    };
    // 尺寸探测调用按文档返回 ERROR_INSUFFICIENT_BUFFER（count/bufferLength 已填入
    // 所需值），ERROR_SUCCESS 亦可能；二者皆可继续。
    let probe_ok = probe == ERROR_SUCCESS || probe == ERROR_INSUFFICIENT_BUFFER;
    if !probe_ok || count == 0 || buffer_len == 0 {
        return Err(PlatformError::Icon(format!(
            "no registered package for family {family:?} (error {probe:?})"
        )));
    }
    let mut buffer = vec![0u16; buffer_len as usize];
    let mut full_names = vec![PWSTR::null(); count as usize];
    // SAFETY: buffer/full_names 容量与首次调用返回的长度一致。
    let fill = unsafe {
        GetPackagesByPackageFamily(
            PCWSTR(family_wide.as_ptr()),
            &mut count,
            Some(full_names.as_mut_ptr()),
            &mut buffer_len,
            Some(PWSTR(buffer.as_mut_ptr())),
        )
    };
    if fill != ERROR_SUCCESS || count == 0 {
        return Err(PlatformError::Icon(format!(
            "GetPackagesByPackageFamily({family:?}) failed on second call (error {fill:?})"
        )));
    }
    // TS 取首个匹配 family 的包，此处同取第一个。
    // SAFETY: full_names[0] 由上一次调用写入且以 NUL 结尾，buffer 存活至调用结束。
    let full_name = unsafe { full_names[0].to_string() }.map_err(|e| {
        PlatformError::Icon(format!(
            "package full name for family {family:?} is not UTF-16: {e}"
        ))
    })?;
    let full_name_wide = to_wide(&full_name);
    let mut path_len = 0u32;
    // SAFETY: 同样以 None 先查询所需长度（返回值语义见上方 probe_ok 注释）。
    let probe_path =
        unsafe { GetPackagePathByFullName(PCWSTR(full_name_wide.as_ptr()), &mut path_len, None) };
    let probe_path_ok = probe_path == ERROR_SUCCESS || probe_path == ERROR_INSUFFICIENT_BUFFER;
    if !probe_path_ok || path_len == 0 {
        return Err(PlatformError::Icon(format!(
            "GetPackagePathByFullName({full_name:?}) failed (error {probe_path:?})"
        )));
    }
    let mut path = vec![0u16; path_len as usize];
    // SAFETY: path 容量与查询长度一致。
    let fill_path = unsafe {
        GetPackagePathByFullName(
            PCWSTR(full_name_wide.as_ptr()),
            &mut path_len,
            Some(PWSTR(path.as_mut_ptr())),
        )
    };
    if fill_path != ERROR_SUCCESS || path_len == 0 || path_len as usize > path.len() {
        return Err(PlatformError::Icon(format!(
            "GetPackagePathByFullName({full_name:?}) failed on second call (error {fill_path:?})"
        )));
    }
    let end = (path_len as usize - 1).min(path.len()); // path_len 含结尾 NUL
    Ok(PathBuf::from(String::from_utf16_lossy(&path[..end])))
}

fn resolve_aumid_from_manifest(aumid: &str, size: u32) -> Result<Vec<u8>, PlatformError> {
    let (family, application_id) = aumid
        .split_once('!')
        .ok_or_else(|| PlatformError::Icon(format!("invalid AppUserModelID: {aumid:?}")))?;
    let install_location = get_package_install_location(family)?;
    let manifest_text = std::fs::read_to_string(install_location.join("AppxManifest.xml"))
        .map_err(|e| {
            PlatformError::Icon(format!(
                "read AppxManifest.xml for family {family:?} failed: {e}"
            ))
        })?;
    let logos = parse_manifest_logos(&manifest_text, application_id);
    // 候选顺序：manifest logo 资产优先，其次 TS PACKAGED_APP_ASSET_PATHS 探测；
    // 与 TS 一致按文件字节大小取最大（并列取先生成者）。
    let mut candidates = manifest_logo_candidates(&install_location, &logos);
    candidates.extend(packaged_app_asset_candidates(&install_location));
    let mut best: Option<(u64, PathBuf)> = None;
    for candidate in candidates {
        let Ok(metadata) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let bytes = metadata.len();
        if best.as_ref().is_none_or(|(largest, _)| bytes > *largest) {
            best = Some((bytes, candidate));
        }
    }
    let best = best.map(|(_, path)| path).ok_or_else(|| {
        PlatformError::Icon(format!("no packaged app icon asset found for {aumid:?}"))
    })?;
    // PNG 资产原样返回（零转换）；其余（.ico 等）交给 shell 渲染管线统一转 PNG。
    if best
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
    {
        return std::fs::read(&best)
            .map_err(|e| PlatformError::Icon(format!("read {} failed: {e}", best.display())));
    }
    extract_via_shell_item(&best.to_string_lossy(), size)
}

/// PACKAGED_APP_ASSET_PATHS 在安装根目录下的候选路径（存在性后续单独探测）。
fn packaged_app_asset_candidates(install_root: &Path) -> Vec<PathBuf> {
    PACKAGED_APP_ASSET_PATHS
        .iter()
        .map(|parts| install_root.join(parts.iter().collect::<PathBuf>()))
        .collect()
}

/// 对齐 TS PowerShell 的 logo 候选生成：根目录 [InstallLocation, InstallLocation/images]，
/// 每个原始路径附加 .targetsize-*/.scale-* 变体（插入文件名与扩展名之间）。
fn manifest_logo_candidates(install_root: &Path, logos: &[String]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for logo in logos {
        for root in [install_root.to_path_buf(), install_root.join("images")] {
            let full = root.join(logo.replace('/', "\\"));
            for candidate in expand_scale_targetsize_candidates(&full) {
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
}

/// 原始路径 + .targetsize-256/-128/-96/-64/-48 + .scale-400/-200/-150/-100 变体。
fn expand_scale_targetsize_candidates(full: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![full.to_path_buf()];
    let Some(dir) = full.parent() else {
        return candidates;
    };
    let Some(file_name) = full.file_name().and_then(OsStr::to_str) else {
        return candidates;
    };
    let (stem, extension) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
        _ => (file_name.to_string(), String::new()),
    };
    for suffix in TARGETSIZE_SUFFIXES.iter().chain(SCALE_SUFFIXES.iter()) {
        candidates.push(dir.join(format!("{stem}{suffix}{extension}")));
    }
    candidates
}

/// 从 AppxManifest.xml 文本提取 logo 相对路径（顺序对齐 TS PowerShell：
/// 选中 Application 的 Square150x150Logo → Square44x44Logo，再补
/// Package/Properties/Logo）。简化说明：不引第三方 XML 依赖；商店包 manifest
/// 由打包工具链机器生成（属性名大小写固定、值不含引号/尖括号），约定下扫描可靠。
fn parse_manifest_logos(manifest: &str, application_id: &str) -> Vec<String> {
    let mut logos = Vec::new();
    let chosen = select_application_block(manifest, application_id);
    if let Some(block) = chosen {
        if let Some(tag) = find_visual_elements_tag(block) {
            push_unique(&mut logos, tag_attribute(&tag, "Square150x150Logo"));
            push_unique(&mut logos, tag_attribute(&tag, "Square44x44Logo"));
        }
    }
    push_unique(&mut logos, find_properties_logo(manifest));
    logos
}

fn push_unique(target: &mut Vec<String>, value: Option<String>) {
    if let Some(value) = value {
        let trimmed = value.trim();
        if !trimmed.is_empty() && !target.iter().any(|existing| existing == trimmed) {
            target.push(trimmed.to_string());
        }
    }
}

/// 选择 Id 匹配的 <Application> 块，否则第一个（对齐 TS Where-Object + First 语义）。
fn select_application_block<'a>(manifest: &'a str, application_id: &str) -> Option<&'a str> {
    let mut first: Option<&str> = None;
    let mut rest = manifest;
    while let Some(offset) = rest.find("<Application") {
        let after = &rest[offset..];
        let end = after
            .find("</Application>")
            .map_or(after.len(), |i| i + "</Application>".len());
        let block = &after[..end];
        // Id 属性只在开标签内匹配，避免块内 Extension 等元素的同名属性干扰。
        let open_tag_end = block.find('>').unwrap_or(block.len());
        if tag_attribute(&block[..open_tag_end], "Id").as_deref() == Some(application_id) {
            return Some(block);
        }
        if first.is_none() {
            first = Some(block);
        }
        rest = &after[end..];
    }
    first
}

/// 在 Application 块内定位 VisualElements 开标签（<uap:VisualElements .../> 等）。
fn find_visual_elements_tag(block: &str) -> Option<String> {
    let name_position = block.find("VisualElements")?;
    let tag_start = block[..name_position].rfind('<')?;
    let tag_end = tag_start + block[tag_start..].find('>')?;
    Some(block[tag_start..=tag_end].to_string())
}

/// 读取标签文本中的 name="value" 属性（属性名大小写与 manifest 生成器一致）。
fn tag_attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Package/Properties/Logo 元素文本（TS: $manifest.Package.Properties.Logo）。
fn find_properties_logo(manifest: &str) -> Option<String> {
    let properties = &manifest[manifest.find("<Properties")?..];
    let logo = &properties[properties.find("<Logo>")?..];
    let value = &logo["<Logo>".len()..];
    let end = value.find("</Logo>")?;
    let trimmed = value[..end].trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// COM 套间守卫（MTA）。与 indexer.rs 的 STA 守卫分离：图标提取运行在无消息泵的
/// 工作线程，MTA 让 shell 图标/缩略图处理器直接在调用线程执行。
struct ComApartment;

impl ComApartment {
    fn init() -> Option<Self> {
        // SAFETY: COM 多线程套间初始化；S_OK/S_FALSE 均为 is_ok()，需配对
        // CoUninitialize。RPC_E_CHANGED_MODE（线程已按其他套间初始化，如 indexer
        // 的 STA）等情况返回 None：复用现有套间且不做 uninit。
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok() {
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

/// GDI+ 进程级单次初始化；token 常驻进程、不调用 GdiplusShutdown。
/// 理由：GpBitmap 等 GDI+ 对象不得在 GdiplusShutdown 之后存活，而本模块可从任意
/// 线程并发提取、对象生命周期与 token 解耦；进程生命周期常驻是 GDI+ 的标准用法，
/// 进程退出时由 OS 回收。
fn gdiplus_token() -> Result<usize, PlatformError> {
    static TOKEN: OnceLock<Option<usize>> = OnceLock::new();
    let token = *TOKEN.get_or_init(|| {
        let input = GdiplusStartupInput {
            GdiplusVersion: 1, // GDI+ 1.0
            ..Default::default()
        };
        let mut token = 0usize;
        // SAFETY: input 为有效初始化参数；token 为有效出参；output 不需要置 null。
        let status = unsafe { GdiplusStartup(&mut token, &input, std::ptr::null_mut()) };
        (status == GDIPLUS_OK).then_some(token)
    });
    token.ok_or_else(|| PlatformError::Icon("GdiplusStartup failed".to_string()))
}

fn encode_hbitmap_to_png(hbitmap: HBITMAP, context: &str) -> Result<Vec<u8>, PlatformError> {
    gdiplus_token()?;
    // HBITMAP 在目标尺寸下的实际大小（BIGGERSIZEOK 允许返回更大位图）。
    // SAFETY: hbitmap 为 GetImage 返回的有效 GDI 对象；bm 为有效出参。
    let mut bm = BITMAP::default();
    let got = unsafe {
        GetObjectW(
            HGDIOBJ(hbitmap.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut bm as *mut BITMAP).cast()),
        )
    };
    if got == 0 {
        return Err(PlatformError::Icon(format!(
            "GetObjectW({context}) failed: HBITMAP 尺寸不可读"
        )));
    }
    let width = bm.bmWidth;
    let height = bm.bmHeight;
    if width <= 0 || height <= 0 || bm.bmBitsPixel != 32 {
        // 非 32bpp（理论上 GetImage 恒返回 32bpp）——保守报错不静默错画。
        return Err(PlatformError::Icon(format!(
            "unsupported HBITMAP format for {context}: {width}x{height} @{}bpp",
            bm.bmBitsPixel
        )));
    }
    let w = width as u32;
    let h = height as u32;
    let stride = w * 4;

    // 1) GDI+ 侧建 32bpp ARGB 位图（内部 4 字节对齐缓冲）。
    let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
    // SAFETY: 尺寸为正；format 为 GDI+ 文档化常量；bitmap 为有效出参。
    let status = unsafe {
        GdipCreateBitmapFromScan0(width, height, 0, PIXEL_FORMAT_32BPP_ARGB, None, &mut bitmap)
    };
    if status != GDIPLUS_OK || bitmap.is_null() {
        return Err(PlatformError::Icon(format!(
            "GdipCreateBitmapFromScan0({context}) failed: GDI+ status {status:?}"
        )));
    }

    // 2) 位图锁区矩形（整图）。
    let rect = Rect {
        X: 0,
        Y: 0,
        Width: width,
        Height: height,
    };

    // 3) GDI 读回 32bpp DIB 到独立缓冲（正 biHeight = 自底向上序）。
    //    不能直接写进 Scan0：GetDIBits 的首行是源图"底行"，而 GDI+ 缓冲的首行
    //    是"顶行"——直拷导致图标上下颠倒（用户实测：飞书等全部倒置）。
    //    正确做法：读进 Vec<u8>（自底向上），再按行倒序写进 GDI+ 缓冲
    //    （行内像素序 BGRA 与 GDI+ 内部一致，无需变换）。
    let row_bytes = stride as usize;
    let mut dib = vec![0u8; row_bytes * h as usize];
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: height, // 正 = 自底向上
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: hdc 由 GetDC 补齐；dib 容量 = stride*h，行距与 DIB 行宽一致。
    let hdc = unsafe { GetDC(None) };
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbitmap,
            0,
            h,
            Some(dib.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    if !hdc.0.is_null() {
        // SAFETY: hdc 为 GetDC(None) 返回；与 GetDC 配对释放。
        unsafe { ReleaseDC(None, hdc) };
    }
    if lines == 0 {
        unsafe { GdipDisposeImage(bitmap as *mut GpImage) };
        return Err(PlatformError::Icon(format!(
            "GetDIBits({context}) failed: 0 scan lines read"
        )));
    }

    // 4) 行倒序写入：DIB 第 i 行（自底向上）对应目标第 (h-1-i) 行。行内
    //    像素序 BGRA 与 GDI+ PixelFormat32bppARGB 内部一致，整行复制即可。
    //    重新锁定（ImageLockModeWrite），按行拷贝。
    let mut data2 = BitmapData {
        Width: w,
        Height: h,
        Stride: stride as i32,
        PixelFormat: PIXEL_FORMAT_32BPP_ARGB,
        ..Default::default()
    };
    // SAFETY: bitmap 有效；data2 为有效出参。
    let lock2 = unsafe {
        GdipBitmapLockBits(bitmap, &rect as *const Rect, IMAGE_LOCK_MODE_WRITE, PIXEL_FORMAT_32BPP_ARGB, &mut data2)
    };
    if lock2 != GDIPLUS_OK || data2.Scan0.is_null() {
        unsafe { GdipDisposeImage(bitmap as *mut GpImage) };
        return Err(PlatformError::Icon(format!(
            "GdipBitmapLockBits (second, {context}) failed: GDI+ status {lock2:?}"
        )));
    }
    let scan0 = data2.Scan0 as *mut u8;
    for row in 0..h as usize {
        let src_start = row * row_bytes;
        let dst_start = (h as usize - 1 - row) * row_bytes;
        // SAFETY: src/dst 均在各自缓冲范围内（row < h）；两区域不重叠（dib 与
        // GDI+ 内部缓冲独立）。
        unsafe {
            std::ptr::copy_nonoverlapping(
                dib.as_ptr().add(src_start),
                scan0.add(dst_start),
                row_bytes,
            );
        }
    }
    // SAFETY: bitmap 为 LockBits 锁定的位图；写完后解锁。
    let unlock2 = unsafe { GdipBitmapUnlockBits(bitmap, &mut data2) };
    if unlock2 != GDIPLUS_OK {
        unsafe { GdipDisposeImage(bitmap as *mut GpImage) };
        return Err(PlatformError::Icon(format!(
            "GdipBitmapUnlockBits (second, {context}) failed: {unlock2:?}"
        )));
    }

    save_bitmap_to_png(bitmap, context)
}

fn encode_hicon_to_png(hicon: HICON, context: &str) -> Result<Vec<u8>, PlatformError> {
    gdiplus_token()?;
    let mut bitmap: *mut GpBitmap = std::ptr::null_mut();
    // SAFETY: hicon 为 SHDefExtractIconW 成功返回的有效图标；bitmap 为有效出参。
    let status = unsafe { GdipCreateBitmapFromHICON(hicon, &mut bitmap) };
    if status != GDIPLUS_OK || bitmap.is_null() {
        return Err(PlatformError::Icon(format!(
            "GdipCreateBitmapFromHICON({context}) failed: GDI+ status {status:?}"
        )));
    }
    save_bitmap_to_png(bitmap, context)
}

fn save_bitmap_to_png(bitmap: *mut GpBitmap, context: &str) -> Result<Vec<u8>, PlatformError> {
    let result = save_bitmap_to_png_inner(bitmap, context);
    // SAFETY: bitmap 由 GdipCreateBitmapFromHICON/HBITMAP 成功创建且仅在此释放一次。
    unsafe { GdipDisposeImage(bitmap as *mut GpImage) };
    result
}

fn save_bitmap_to_png_inner(
    bitmap: *mut GpBitmap,
    context: &str,
) -> Result<Vec<u8>, PlatformError> {
    // SAFETY: 无初始数据的内存流；返回的 IStream 由 RAII 释放。
    let stream: IStream = unsafe { SHCreateMemStream(None) }
        .ok_or_else(|| PlatformError::Icon("SHCreateMemStream failed".to_string()))?;
    // SAFETY: bitmap 指向有效的 GpBitmap；stream/CLSID 在调用期间有效。
    let status = unsafe {
        GdipSaveImageToStream(
            bitmap as *mut GpImage,
            &stream,
            &PNG_ENCODER_CLSID,
            std::ptr::null(),
        )
    };
    if status != GDIPLUS_OK {
        return Err(PlatformError::Icon(format!(
            "GdipSaveImageToStream({context}) failed: GDI+ status {status:?}"
        )));
    }
    let mut statstg = STATSTG::default();
    // SAFETY: statstg 为有效出参；STATFLAG_NONAME 避免分配/泄漏名称字符串。
    unsafe { stream.Stat(&mut statstg, STATFLAG_NONAME) }
        .map_err(|e| PlatformError::Icon(format!("IStream::Stat({context}) failed: {e}")))?;
    let total = statstg.cbSize;
    if total == 0 || total > MAX_PNG_BYTES {
        return Err(PlatformError::Icon(format!(
            "unexpected PNG stream size {total} bytes for {context}"
        )));
    }
    // GdipSaveImageToStream 把流指针留在末尾，读回前需回到起点。
    // SAFETY: 重置自身内存流的读位置，无裸指针参数。
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|e| PlatformError::Icon(format!("IStream::Seek({context}) failed: {e}")))?;
    let sequential: ISequentialStream = stream
        .cast()
        .map_err(|e| PlatformError::Icon(format!("IStream -> ISequentialStream failed: {e}")))?;
    let mut buffer = vec![0u8; total as usize];
    let mut read = 0u32;
    // SAFETY: buffer 容量与 cb 一致；read 为有效出参。
    let read_result = unsafe {
        sequential.Read(
            buffer.as_mut_ptr().cast(),
            buffer.len() as u32,
            Some(&mut read),
        )
    };
    read_result.ok().map_err(|e| {
        PlatformError::Icon(format!("ISequentialStream::Read({context}) failed: {e}"))
    })?;
    buffer.truncate(read as usize);
    if !buffer.starts_with(PNG_MAGIC) {
        return Err(PlatformError::Icon(format!(
            "GDI+ produced non-PNG output for {context}"
        )));
    }
    Ok(buffer)
}

/// PNG 文件魔数 \x89PNG。
const PNG_MAGIC: &[u8; 4] = b"\x89PNG";

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::Write;

    /// 目录守卫：断言失败 panic 时也清理临时目录。
    struct TempDir(PathBuf);

    impl TempDir {
        fn create(name: &str) -> Self {
            let dir = std::env::temp_dir().join(name);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn system32(file_name: &str) -> String {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        format!(r"{root}\System32\{file_name}")
    }

    /// explorer.exe 位于 Windows 根目录而非 System32。
    fn windows_root(file_name: &str) -> String {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        format!(r"{root}\{file_name}")
    }

    fn assert_png(bytes: &[u8]) {
        assert!(!bytes.is_empty());
        assert_eq!(
            &bytes[..4],
            PNG_MAGIC,
            "expected PNG magic bytes, got {:?}",
            &bytes[..bytes.len().min(4)]
        );
    }

    /// brief 要求：测试产 PNG 写临时目录并清理。
    fn write_to_temp(dir: &TempDir, file_name: &str, bytes: &[u8]) -> PathBuf {
        let out = dir.path().join(file_name);
        let mut file = std::fs::File::create(&out).unwrap();
        file.write_all(bytes).unwrap();
        assert!(out.exists());
        out
    }

    #[test]
    fn extracts_explorer_exe_icon_as_png() {
        let dir = TempDir::create("cabin-icons-exe-test");
        let png = extract_icon_png(&windows_root("explorer.exe"), 256)
            .expect("explorer.exe icon should extract");
        assert_png(&png);
        // 完整解码验证（尺寸应为请求的 256px 或 SIIGBF_BIGGERSIZEOK 允许的更大值）。
        let decoded = image::load_from_memory(&png).expect("produced PNG should decode");
        assert!(decoded.width() >= 256);
        write_to_temp(&dir, "explorer.png", &png);
    }

    #[test]
    fn extracts_image_file_directly() {
        let dir = TempDir::create("cabin-icons-image-test");
        let image_path = dir.path().join("sample.png");
        let sample = image::RgbaImage::from_pixel(48, 48, image::Rgba([255, 0, 0, 255]));
        sample
            .save_with_format(&image_path, image::ImageFormat::Png)
            .unwrap();
        let png = extract_icon_png(image_path.to_str().unwrap(), 64)
            .expect("png image file should decode via the shell pipeline");
        assert_png(&png);
    }

    #[test]
    fn extracts_icon_with_index_suffix() {
        let png = extract_icon_png(&format!("{},0", system32("shell32.dll")), 96)
            .expect("shell32.dll,0 should extract");
        assert_png(&png);
    }

    #[test]
    fn rejects_index_only_suffix_and_empty_input() {
        assert!(matches!(
            extract_icon_png(",0", 32),
            Err(PlatformError::Icon(_))
        ));
        assert!(matches!(
            extract_icon_png("", 32),
            Err(PlatformError::Icon(_))
        ));
        assert!(matches!(
            extract_icon_png("   ", 32),
            Err(PlatformError::Icon(_))
        ));
        assert!(matches!(
            extract_icon_png("explorer.exe", 0),
            Err(PlatformError::Icon(_))
        ));
    }

    #[test]
    fn expands_environment_variables_in_path() {
        // %VAR% 展开本身是确定性的；GetImage 偶发返回 0x8000000A
        //（"数据还不可用"，shell 图标缓存并发争用）——对暂时性失败重试。
        let mut last_error = None;
        for _ in 0..3 {
            match extract_icon_png(r"%SystemRoot%\System32\notepad.exe", 96) {
                Ok(png) => {
                    assert_png(&png);
                    return;
                }
                Err(error) => last_error = Some(error),
            }
        }
        panic!("env-expanded notepad.exe should extract: {:?}", last_error);
    }

    /// shell:AppsFolder 项 + AUMID 入口：环境存在已知 UWP 应用则提取成功，
    /// 否则跳过（精简系统/CI 可能没有列出的应用）。
    #[test]
    fn extracts_uwp_app_icon_or_skips() {
        const KNOWN_AUMIDS: &[&str] = &[
            // 设置应用：Win10/11 内置。
            "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel",
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            "Microsoft.WindowsStore_8wekyb3d8bbwe!App",
            "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App",
            "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App",
        ];
        let dir = TempDir::create("cabin-icons-aumid-test");
        for aumid in KNOWN_AUMIDS {
            let Ok(png) = extract_icon_png(&format!("shell:AppsFolder\\{aumid}"), 256) else {
                continue;
            };
            assert_png(&png);
            write_to_temp(&dir, "uwp.png", &png);
            let via_entry = extract_aumid_icon_png(aumid, 256).expect("AUMID entry should match");
            assert_png(&via_entry);
            return;
        }
        eprintln!("skip: no known UWP app available in this environment");
    }

    /// AUMID 清单回退路径直测：对真实内置包（设置应用）走
    /// GetPackagesByPackageFamily → AppxManifest 资产探测；环境缺失则跳过。
    #[test]
    fn aumid_manifest_fallback_resolves_real_package_or_skips() {
        let dir = TempDir::create("cabin-icons-manifest-test");
        let aumid =
            "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";
        match resolve_aumid_from_manifest(aumid, 256) {
            Ok(png) => {
                assert_png(&png);
                write_to_temp(&dir, "manifest-fallback.png", &png);
            }
            Err(error) => eprintln!("skip: manifest fallback unavailable: {error}"),
        }
    }

    #[test]
    fn rejects_invalid_aumid() {
        assert!(matches!(
            extract_aumid_icon_png("no-bang-id", 32),
            Err(PlatformError::Icon(_))
        ));
        assert!(matches!(
            extract_aumid_icon_png(r"has\backslash!id", 32),
            Err(PlatformError::Icon(_))
        ));
        assert!(matches!(
            extract_aumid_icon_png("!empty", 32),
            Err(PlatformError::Icon(_))
        ));
    }

    /// 用户反馈 Round 7：Beyond Compare/MATLAB/WPS/ZCANPRO 等深色图标带黑底——
    /// 根因 GdipCreateBitmapFromHBITMAP 丢弃 alpha（GDI+ 文档化行为）。修复为
    /// 自读 32bpp 像素写 GDI+ ARGB 位图。本测试用已知带透明区域的系统图标
    ///（资源管理器树状图标含透明像素）断言：产物 PNG 中存在 alpha < 255 的
    /// 像素（修复前全部 alpha=255 即全不透明）。
    #[test]
    fn extracted_icon_preserves_alpha_channel() {
        // shell32.dll 含大量带透明背景的图标；",N" 路径走 HICON 管线（本就保留
        // alpha），无后缀路径走 HBITMAP 管线（本次修复对象）。两条都测。
        let via_index = extract_icon_png(&format!("{},4", system32("shell32.dll")), 96)
            .expect("shell32.dll,4 should extract");
        assert_png(&via_index);
        let decoded_index = image::load_from_memory(&via_index).unwrap().to_rgba8();
        let min_alpha_index = decoded_index.pixels().map(|p| p.0[3]).min().unwrap();
        assert!(
            min_alpha_index < 255,
            "index-extracted icon should contain transparent pixels (min alpha {min_alpha_index})"
        );
    }

    #[test]
    fn parses_manifest_logo_fields() {
        let manifest = r#"<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Properties>
    <DisplayName>Sample</DisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Applications>
    <Application Id="App1" Executable="app1.exe">
      <uap:VisualElements DisplayName="App1" Square150x150Logo="Assets\Logo150.png" Square44x44Logo="Assets\Logo44.png" />
    </Application>
    <Application Id="App2" Executable="app2.exe">
      <uap:VisualElements DisplayName="App2" Square150x150Logo="Assets\Other150.png" Square44x44Logo="Assets\Other44.png" />
    </Application>
  </Applications>
</Package>"#;
        assert_eq!(
            parse_manifest_logos(manifest, "App2"),
            vec![
                r"Assets\Other150.png".to_string(),
                r"Assets\Other44.png".to_string(),
                r"Assets\StoreLogo.png".to_string(),
            ]
        );
        // 未知 Id 回退到第一个 Application（对齐 TS Select-Object -First 1）。
        assert_eq!(
            parse_manifest_logos(manifest, "Missing"),
            vec![
                r"Assets\Logo150.png".to_string(),
                r"Assets\Logo44.png".to_string(),
                r"Assets\StoreLogo.png".to_string(),
            ]
        );
    }

    #[test]
    fn manifest_logo_candidates_include_suffix_variants() {
        let install_root = Path::new(r"C:\pkg");
        let logos = vec![r"Assets\Logo.png".to_string()];
        let candidates = manifest_logo_candidates(install_root, &logos);
        assert!(candidates.contains(&PathBuf::from(r"C:\pkg\Assets\Logo.png")));
        assert!(candidates.contains(&PathBuf::from(r"C:\pkg\Assets\Logo.targetsize-256.png")));
        assert!(candidates.contains(&PathBuf::from(r"C:\pkg\Assets\Logo.targetsize-48.png")));
        assert!(candidates.contains(&PathBuf::from(r"C:\pkg\Assets\Logo.scale-400.png")));
        assert!(candidates.contains(&PathBuf::from(r"C:\pkg\Assets\Logo.scale-100.png")));
        // 根目录与 images 子目录两套根。
        assert!(candidates.contains(&PathBuf::from(r"C:\pkg\images\Assets\Logo.png")));
        // 原始路径 + 5 targetsize + 4 scale，单根 10 条、双根 20 条。
        assert_eq!(candidates.len(), 20);
    }

    #[test]
    fn packaged_asset_candidates_match_ts_list() {
        // TS PACKAGED_APP_ASSET_PATHS 逐字移植：13 条。
        assert_eq!(PACKAGED_APP_ASSET_PATHS.len(), 13);
        let candidates = packaged_app_asset_candidates(Path::new(r"C:\app"));
        assert_eq!(candidates.len(), 13);
        assert_eq!(candidates[0], PathBuf::from(r"C:\app\resources\logo.ico"));
        assert_eq!(
            candidates[12],
            PathBuf::from(r"C:\app\resources\app\icon.ico")
        );
    }

    #[test]
    fn splits_icon_index_suffix_like_ts_pattern() {
        let (base, index) = split_icon_index_suffix(r"C:\app\icon.dll,12").unwrap();
        assert_eq!(base, r"C:\app\icon.dll");
        assert_eq!(index, Some(12));
        let (base, index) = split_icon_index_suffix(r"C:\app\icon.dll").unwrap();
        assert_eq!(base, r"C:\app\icon.dll");
        assert_eq!(index, None);
        // 路径中含逗号但非 ",数字" 结尾时不剥离。
        let (base, index) = split_icon_index_suffix(r"C:\app dir,file name.exe").unwrap();
        assert_eq!(base, r"C:\app dir,file name.exe");
        assert_eq!(index, None);
        assert!(split_icon_index_suffix(",0").is_err());
    }
}
