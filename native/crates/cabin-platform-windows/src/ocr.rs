//! Windows OCR：`Windows.Media.Ocr`（WinRT）进程内直调，取代 TS 的
//! PowerShell 桥（`apps/desktop/src/main/screenshot/localOcr.ts`）。
//!
//! 行为对齐 TS（localOcr.ts:99-137 + shared/screenshotApi.ts 的判别联合）：
//! - 语言候选表逐字移植：zh-CN → `[zh-CN, zh-Hans-CN, zh-Hans, zh]`、
//!   zh-TW → `[zh-TW, zh-Hant-TW, zh-Hant, zh]`、en-US → `[en-US, en]`、
//!   其他 → `[tag]`（[`language_candidates`]）。
//! - 解析 = 对 `OcrEngine::AvailableRecognizerLanguages` 的两轮匹配
//!   （[`resolve_language_index`]）：先大小写不敏感的整 tag 精确匹配，再
//!   `candidate-` / `available-` 前缀互含匹配。报告的 `language` 是**命中的
//!   请求 tag**（TS `$ResolvedLanguageTag = $RequestedLanguageTag`），不是
//!   可用语言的原始 tag。
//! - OCR 因语言包缺失而不可用是**成功结果**（`status = unavailable`，对齐
//!   TS 把它建模在 JSON 结果里而非异常）：消息逐字为
//!   `Windows OCR is not available for the selected language.`，且存在可用
//!   语言时追加 ` Available OCR languages: <tags 逗号连接>.`。仅基础设施
//!   失败（PNG 解码失败、WinRT 调用失败、超时）返回 `Err(PlatformError)`。
//! - 成功：`status = success`、`text = lines.join("\n")`（允许空串）。
//!
//! WinRT 管线：PNG 字节 → `InMemoryRandomAccessStream`（`DataWriter` 写入、
//! `StoreAsync` + `FlushAsync`、`DetachStream` 防析构关流、`Seek(0)` 回卷）→
//! `BitmapDecoder::CreateAsync` → `GetSoftwareBitmapAsync` →
//! `OcrEngine::TryCreateFromLanguage` → `RecognizeAsync` → `Lines[i].Text`。
//!
//! # WinRT 异步等待策略
//!
//! [`wait_for_operation`] 以简单轮询循环消费 `IAsyncOperation`：每 10ms 读一次
//! `Status()`，`Completed` 时 `GetResults()`，`Error`/`Canceled` 时以底层
//! HRESULT 报错；整条管线共享一个从进入 [`run_ocr`] 起算的 deadline
//! （[`DEFAULT_OCR_TIMEOUT_MS`] = 10s，对齐 TS `DEFAULT_OCR_TIMEOUT_MS` 的
//! 整进程超时语义），超时返回 `Err(PlatformError::Ocr)`。刻意不引入
//! `windows-future` 的 async runtime / futures 栈——调用方（M4 的 IPC 编排）
//! 是同步工作线程，轮询 10ms 间隔的 CPU 开销可忽略。
//!
//! # Apartment（套间）选择
//!
//! [`ComApartment`] 以 `CoInitializeEx(MTA)` 初始化（复用 icons.rs 工作线程
//! 先例）。选择依据：WinRT 类默认聚合自由线程封送器（agile），
//! `OcrEngine` 与 `IAsyncOperation` 均为 agile——异步操作在系统线程池完成，
//! 从 MTA 线程轮询 `Status()` 无需消息泵；MTA 也不阻塞同进程其他线程的
//! WinRT/COM 调用。TS 的 PowerShell 路径运行在 STA 只是 Windows PowerShell
//! 5.1 宿主的默认值，并非 `OcrEngine` 的要求。若线程已被初始化为其他套间
//! （`RPC_E_CHANGED_MODE`），守卫复用现有套间且不做配对反初始化（agile
//! 对象在两种套间下都可使用）。
//!
//! 与 TS 的有意差异：TS 把 PowerShell 子进程超时（exec `ETIMEDOUT`）归入
//! "PowerShell could not be started" 的 unavailable 分支；原生路径没有
//! PowerShell，OCR 超时是基础设施失败 → `Err`。

use std::time::{Duration, Instant};

use cabin_platform::traits::PlatformError;
use windows::core::RuntimeType;
use windows::Globalization::Language;
use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
use windows::Media::Ocr::{OcrEngine, OcrLine, OcrResult};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
use windows_future::{AsyncStatus, IAsyncOperation};

/// TS `DEFAULT_OCR_TIMEOUT_MS`（localOcr.ts:17）逐字移植。
pub const DEFAULT_OCR_TIMEOUT_MS: u64 = 10_000;

/// `Status()` 轮询间隔；OCR 识别通常在数百毫秒内完成，10ms 轮询开销可忽略。
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// TS `ScreenshotOcrResult` 的三态判别。`Error` 不由 [`run_ocr`] 产生
/// （基础设施失败走 `Err(PlatformError::Ocr)`），保留以完整对齐判别联合
/// 的形状契约（M4 IPC 序列化使用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrStatus {
    Success,
    Unavailable,
    Error,
}

/// TS `ScreenshotOcrResult` 三变体的统一承载（判别字段 `status`）。
/// success 填充 `text` / `lines`（`text` 允许空串）；unavailable 填充
/// `message`；`language` 为实际解析出的请求 tag。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OcrOutcome {
    pub status: OcrStatus,
    /// 实际解析语言（命中的请求 tag，对齐 TS `$ResolvedLanguageTag`）。
    pub language: String,
    pub text: Option<String>,
    pub lines: Vec<String>,
    pub message: Option<String>,
}

/// TS localOcr.ts:99-106 的语言候选表（逐字）。default 分支带输入 tag，
/// 故返回 owned String。
fn language_candidates(tag: &str) -> Vec<String> {
    match tag {
        "zh-CN" => ["zh-CN", "zh-Hans-CN", "zh-Hans", "zh"]
            .map(str::to_string)
            .to_vec(),
        "zh-TW" => ["zh-TW", "zh-Hant-TW", "zh-Hant", "zh"]
            .map(str::to_string)
            .to_vec(),
        "en-US" => ["en-US", "en"].map(str::to_string).to_vec(),
        other => vec![other.to_string()],
    }
}

/// 大小写不敏感前缀匹配（`StartsWith(prefix)` 语义）。语言 tag 子标签为
/// ASCII，`eq_ignore_ascii_case` 覆盖 .NET `OrdinalIgnoreCase` 的实际生效
/// 范围；含非 ASCII 字符的异常 tag 返回 false（保守降级，不 panic）。
fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// TS `Resolve-OcrLanguage`（localOcr.ts:108-137）的两轮匹配。
/// 返回命中的 available 列表索引；无命中 → `None`。
fn resolve_language_index(candidates: &[String], available_tags: &[&str]) -> Option<usize> {
    // 第一轮：整 tag 精确匹配（OrdinalIgnoreCase）。
    for candidate in candidates {
        for (index, available) in available_tags.iter().enumerate() {
            if available.eq_ignore_ascii_case(candidate) {
                return Some(index);
            }
        }
    }
    // 第二轮：candidateTag- / availableTag- 前缀互含。
    for candidate in candidates {
        for (index, available) in available_tags.iter().enumerate() {
            if starts_with_ignore_case(available, &format!("{candidate}-"))
                || starts_with_ignore_case(candidate, &format!("{available}-"))
            {
                return Some(index);
            }
        }
    }
    None
}

/// TS localOcr.ts:159-168 的 unavailable 消息：固定前缀 + 可用语言列表
/// （存在时）。
fn unavailable_message(available_tags: &[&str]) -> String {
    let mut message = "Windows OCR is not available for the selected language.".to_string();
    if !available_tags.is_empty() {
        message.push_str(&format!(
            " Available OCR languages: {}.",
            available_tags.join(", ")
        ));
    }
    message
}

fn ocr_error(context: &str, error: impl std::fmt::Display) -> PlatformError {
    PlatformError::Ocr(format!("{context} failed: {error}"))
}

/// 轮询等待 `IAsyncOperation` 完成（见模块注释的等待策略与超时语义）。
fn wait_for_operation<T>(
    operation: &IAsyncOperation<T>,
    deadline: Instant,
    context: &str,
) -> Result<T, PlatformError>
where
    T: RuntimeType + 'static,
{
    loop {
        let status = operation
            .Status()
            .map_err(|error| ocr_error(&format!("{context}::Status"), error))?;
        if status == AsyncStatus::Completed {
            return operation
                .GetResults()
                .map_err(|error| ocr_error(context, error));
        }
        if status == AsyncStatus::Error || status == AsyncStatus::Canceled {
            // Error/Canceled 时 GetResults 返回底层 HRESULT 失败。
            return operation
                .GetResults()
                .map_err(|error| ocr_error(context, error));
        }
        if Instant::now() >= deadline {
            return Err(PlatformError::Ocr(format!(
                "Windows OCR timed out after {DEFAULT_OCR_TIMEOUT_MS} ms while waiting for {context}."
            )));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// COM 套间守卫（MTA）。套间选择的论证见模块注释；与 icons.rs 的同名守卫
/// 一致：`RPC_E_CHANGED_MODE`（线程已按其他套间初始化）时复用现有套间、
/// 返回 None 且不做配对反初始化。
struct ComApartment;

impl ComApartment {
    fn init() -> Option<Self> {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // SAFETY: COM 多线程套间初始化；S_OK/S_FALSE 均为 is_ok()，成功时
        // 需在 Drop 中配对 CoUninitialize。
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok() {
            Some(Self)
        } else {
            None
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        use windows::Win32::System::Com::CoUninitialize;
        // SAFETY: 与 init 中成功的 CoInitializeEx 配对。
        unsafe { CoUninitialize() };
    }
}

/// 对 PNG 字节执行本地 OCR。`language` 为主语言 tag（如 "zh-CN"），
/// `fallback_languages` 依次降级（对齐 TS `getUniqueOcrLanguages`：主语言 +
/// fallback 去重后逐个尝试）。
pub fn run_ocr(
    png: &[u8],
    language: &str,
    fallback_languages: &[&str],
) -> Result<OcrOutcome, PlatformError> {
    let _com = ComApartment::init();
    let deadline = Instant::now() + Duration::from_millis(DEFAULT_OCR_TIMEOUT_MS);

    // 请求语言序列：主语言 + fallback 去重（TS getUniqueOcrLanguages）。
    let mut requested: Vec<&str> = vec![language];
    for tag in fallback_languages {
        if !requested.contains(tag) {
            requested.push(tag);
        }
    }

    // 一次枚举可用识别语言；WinRT 枚举失败是基础设施失败 → Err。
    let available = OcrEngine::AvailableRecognizerLanguages()
        .map_err(|error| ocr_error("OcrEngine.AvailableRecognizerLanguages", error))?;
    let available_count = available
        .Size()
        .map_err(|error| ocr_error("IVectorView<Language>::Size", error))?;
    let mut available_tags: Vec<(Language, String)> = Vec::with_capacity(available_count as usize);
    for index in 0..available_count {
        let entry = available
            .GetAt(index)
            .map_err(|error| ocr_error("IVectorView<Language>::GetAt", error))?;
        let tag = entry
            .LanguageTag()
            .map_err(|error| ocr_error("Language::LanguageTag", error))?
            .to_string();
        available_tags.push((entry, tag));
    }
    let available_tag_texts: Vec<&str> =
        available_tags.iter().map(|(_, tag)| tag.as_str()).collect();

    // 两轮解析：逐请求语言尝试候选表；命中即停（报告命中的请求 tag）。
    let mut resolved: Option<(Language, String)> = None;
    for requested_tag in &requested {
        let candidates = language_candidates(requested_tag);
        if let Some(index) = resolve_language_index(&candidates, &available_tag_texts) {
            resolved = Some((available_tags[index].0.clone(), requested_tag.to_string()));
            break;
        }
    }
    let Some((resolved_language, resolved_tag)) = resolved else {
        return Ok(OcrOutcome {
            status: OcrStatus::Unavailable,
            language: language.to_string(),
            text: None,
            lines: Vec::new(),
            message: Some(unavailable_message(&available_tag_texts)),
        });
    };

    // TS localOcr.ts:170-178：TryCreateFromLanguage 失败（返回 null）是
    // unavailable 而非异常。windows crate 把 null 投影为 Err。
    let engine = match OcrEngine::TryCreateFromLanguage(&resolved_language) {
        Ok(engine) => engine,
        Err(_) => {
            return Ok(OcrOutcome {
                status: OcrStatus::Unavailable,
                language: resolved_tag,
                text: None,
                lines: Vec::new(),
                message: Some(unavailable_message(&available_tag_texts)),
            });
        }
    };

    // PNG → 内存流。DataWriter 析构会关闭其包装的流，故写完先 DetachStream。
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|error| ocr_error("InMemoryRandomAccessStream::new", error))?;
    let output = stream
        .GetOutputStreamAt(0)
        .map_err(|error| ocr_error("IRandomAccessStream::GetOutputStreamAt", error))?;
    let writer = DataWriter::CreateDataWriter(&output)
        .map_err(|error| ocr_error("DataWriter::CreateDataWriter", error))?;
    writer
        .WriteBytes(png)
        .map_err(|error| ocr_error("DataWriter::WriteBytes", error))?;
    let stored = writer
        .StoreAsync()
        .map_err(|error| ocr_error("DataWriter::StoreAsync", error))?;
    let _: u32 = wait_for_operation(&stored, deadline, "DataWriter.StoreAsync")?;
    let flushed = writer
        .FlushAsync()
        .map_err(|error| ocr_error("DataWriter::FlushAsync", error))?;
    let _: bool = wait_for_operation(&flushed, deadline, "DataWriter.FlushAsync")?;
    writer
        .DetachStream()
        .map_err(|error| ocr_error("DataWriter::DetachStream", error))?;
    drop(output);
    // 解码器从流起点读取；写入后回卷。
    stream
        .Seek(0)
        .map_err(|error| ocr_error("IRandomAccessStream::Seek", error))?;

    let decoder_operation = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| ocr_error("BitmapDecoder::CreateAsync", error))?;
    let decoder = wait_for_operation(&decoder_operation, deadline, "BitmapDecoder.CreateAsync")?;
    let bitmap_operation = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|error| ocr_error("BitmapDecoder::GetSoftwareBitmapAsync", error))?;
    let bitmap: SoftwareBitmap = wait_for_operation(
        &bitmap_operation,
        deadline,
        "BitmapDecoder.GetSoftwareBitmapAsync",
    )?;
    let recognize_operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| ocr_error("OcrEngine::RecognizeAsync", error))?;
    let result: OcrResult =
        wait_for_operation(&recognize_operation, deadline, "OcrEngine.RecognizeAsync")?;

    let lines_view = result
        .Lines()
        .map_err(|error| ocr_error("OcrResult::Lines", error))?;
    let lines_count = lines_view
        .Size()
        .map_err(|error| ocr_error("IVectorView<OcrLine>::Size", error))?;
    let mut lines: Vec<String> = Vec::with_capacity(lines_count as usize);
    for index in 0..lines_count {
        let line: OcrLine = lines_view
            .GetAt(index)
            .map_err(|error| ocr_error("IVectorView<OcrLine>::GetAt", error))?;
        lines.push(
            line.Text()
                .map_err(|error| ocr_error("OcrLine::Text", error))?
                .to_string(),
        );
    }

    Ok(OcrOutcome {
        status: OcrStatus::Success,
        language: resolved_tag,
        text: Some(lines.join("\n")),
        lines,
        message: None,
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn unavailable_message_refs(tags: &[String]) -> String {
        unavailable_message(&tags.iter().map(String::as_str).collect::<Vec<_>>())
    }

    #[test]
    fn language_candidate_table_is_verbatim() {
        assert_eq!(
            language_candidates("zh-CN"),
            ["zh-CN", "zh-Hans-CN", "zh-Hans", "zh"].map(str::to_string),
        );
        assert_eq!(
            language_candidates("zh-TW"),
            ["zh-TW", "zh-Hant-TW", "zh-Hant", "zh"].map(str::to_string),
        );
        assert_eq!(
            language_candidates("en-US"),
            ["en-US", "en"].map(str::to_string)
        );
        // 非 union 成员走 default 分支：单元素表。
        assert_eq!(language_candidates("fr-FR"), ["fr-FR"].map(str::to_string));
        // 大小写不同不进 switch（TS switch 精确匹配语义）。
        assert_eq!(language_candidates("ZH-CN"), ["ZH-CN"].map(str::to_string));
    }

    #[test]
    fn resolution_prefers_exact_matches_over_prefix() {
        // 第一轮精确匹配优先：en-US 直接命中，即便 en-GB 也满足前缀轮。
        let available = ["en-GB", "en-US"];
        assert_eq!(
            resolve_language_index(&language_candidates("en-US"), &available),
            Some(1),
        );
    }

    #[test]
    fn resolution_falls_back_to_prefix_round() {
        // zh-CN 的 zh-Hans-CN 候选与 available "zh-Hans-CN-x-m0" 不可能……用
        // 现实案例：available 只有 "zh-Hans"（简体泛型包），zh-CN 期望走
        // 前缀轮命中（candidate "zh-Hans" 是 available 的前缀）。
        let available = ["en-US", "zh-Hans"];
        assert_eq!(
            resolve_language_index(&language_candidates("zh-CN"), &available),
            Some(1),
        );
        // 反向：available "zh-CN-xxx" 以 candidate "zh-CN-" 开头。
        let available = ["zh-CN-x-emoji"];
        assert_eq!(
            resolve_language_index(&language_candidates("zh-CN"), &available),
            Some(0),
        );
        // en-US 在只有 "en-GB" 时：候选 "en" 是 available "en-GB" 的前缀。
        let available = ["en-GB"];
        assert_eq!(
            resolve_language_index(&language_candidates("en-US"), &available),
            Some(0),
        );
    }

    #[test]
    fn resolution_is_case_insensitive_and_none_when_unmatched() {
        let available = ["EN-us"];
        assert_eq!(
            resolve_language_index(&language_candidates("en-US"), &available),
            Some(0),
        );
        let available = ["ja", "ko"];
        assert_eq!(
            resolve_language_index(&language_candidates("zh-CN"), &available),
            None,
        );
        assert_eq!(
            resolve_language_index(&language_candidates("en-US"), &[]),
            None,
        );
    }

    #[test]
    fn unavailable_message_matches_ts_shape() {
        // 无可用语言：固定前缀，无列表段。
        assert_eq!(
            unavailable_message_refs(&[]),
            "Windows OCR is not available for the selected language.",
        );
        // 有可用语言：逐字追加 " Available OCR languages: ..."（含句号）。
        assert_eq!(
            unavailable_message_refs(&["en-US".to_string(), "zh-CN".to_string()]),
            "Windows OCR is not available for the selected language. \
             Available OCR languages: en-US, zh-CN.",
        );
    }

    /// 用内嵌 Liberation Sans 渲染大号黑字白底文本 PNG（M3 T3 字体资产）。
    fn render_text_png(text: &str, font_px: f32) -> Vec<u8> {
        use fontdue::{Font, FontSettings};

        const FONT_BYTES: &[u8] =
            include_bytes!("../../../assets/fonts/LiberationSans-Regular.ttf");
        let font =
            Font::from_bytes(FONT_BYTES, FontSettings::default()).expect("embedded font parses");
        let metrics = font
            .horizontal_line_metrics(font_px)
            .expect("Liberation Sans has line metrics");
        let padding = (font_px * 0.5).ceil() as usize;
        let baseline = padding as f32 + metrics.ascent;

        let mut pen_x = padding as f32;
        let mut placed = Vec::new();
        let mut previous: Option<char> = None;
        for character in text.chars() {
            let glyph_index = font.lookup_glyph_index(character);
            if glyph_index == 0 {
                previous = None;
                continue;
            }
            if let Some(previous) = previous {
                if let Some(kern) = font.horizontal_kern(previous, character, font_px) {
                    pen_x += kern;
                }
            }
            let (glyph_metrics, coverage) = font.rasterize_indexed(glyph_index, font_px);
            placed.push((
                pen_x + glyph_metrics.xmin as f32,
                baseline - glyph_metrics.ymin as f32 - glyph_metrics.height as f32,
                glyph_metrics.width,
                glyph_metrics.height,
                coverage,
            ));
            pen_x += glyph_metrics.advance_width;
        }

        let width = (pen_x.ceil() as usize) + padding;
        let height = (baseline.ceil() as usize) + padding + 4;
        let mut canvas = vec![255u8; width * height * 4];
        for (left, top, glyph_width, glyph_height, coverage) in placed {
            for row in 0..glyph_height {
                for column in 0..glyph_width {
                    let alpha = coverage[row * glyph_width + column];
                    if alpha == 0 {
                        continue;
                    }
                    let x = left as usize + column;
                    let y = top as usize + row;
                    if x >= width || y >= height {
                        continue;
                    }
                    // 白底黑字：按覆盖率把通道压向黑。
                    let offset = (y * width + x) * 4;
                    let value = 255 - alpha;
                    canvas[offset] = value;
                    canvas[offset + 1] = value;
                    canvas[offset + 2] = value;
                    canvas[offset + 3] = 255;
                }
            }
        }

        let image = image::RgbaImage::from_raw(width as u32, height as u32, canvas)
            .expect("canvas dimensions match");
        let mut png = Vec::new();
        use image::{ExtendedColorType, ImageEncoder};
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                image.as_raw(),
                width as u32,
                height as u32,
                ExtendedColorType::Rgba8,
            )
            .expect("PNG encode");
        png
    }

    /// 真机枚举可用 OCR 语言 tag（Size/GetAt，对齐生产路径）。
    fn available_language_tags() -> Vec<String> {
        let view = OcrEngine::AvailableRecognizerLanguages().expect("AvailableRecognizerLanguages");
        let count = view.Size().expect("IVectorView<Language>::Size");
        (0..count)
            .map(|index| {
                view.GetAt(index)
                    .expect("IVectorView<Language>::GetAt")
                    .LanguageTag()
                    .expect("Language::LanguageTag")
                    .to_string()
            })
            .collect()
    }

    /// 真机两路：zh-CN/en-US 语言包存在则真跑 OCR 断言行文本；否则断言
    /// unavailable 消息形状（语言表 + 列表段）。
    #[test]
    fn ocr_reads_rendered_text_or_reports_unavailable() {
        let available = available_language_tags();
        let available_refs: Vec<&str> = available.iter().map(String::as_str).collect();
        let english_available =
            resolve_language_index(&language_candidates("en-US"), &available_refs).is_some();

        let png = render_text_png("CommandCabin OCR 123", 96.0);
        let outcome =
            run_ocr(&png, "en-US", &[]).expect("infrastructural failures must surface as Err");

        if english_available {
            assert_eq!(outcome.status, OcrStatus::Success);
            assert_eq!(outcome.language, "en-US");
            assert!(outcome.message.is_none());
            let text = outcome.text.clone().expect("success carries text");
            assert_eq!(outcome.text.as_deref(), Some(text.as_str()));
            // 干净的 96px 打印体 OCR 应稳定复现单词（大小写不敏感断言）。
            assert!(
                text.to_ascii_lowercase().contains("commandcabin"),
                "OCR text {text:?} should contain the rendered text"
            );
            assert!(
                text.contains("123"),
                "OCR text {text:?} should contain the rendered digits"
            );
            assert!(!outcome.lines.is_empty());
        } else {
            assert_eq!(outcome.status, OcrStatus::Unavailable);
            assert_eq!(outcome.language, "en-US");
            assert_eq!(outcome.text, None);
            assert!(outcome.lines.is_empty());
            assert_eq!(
                outcome.message.as_deref(),
                Some(unavailable_message_refs(&available).as_str()),
            );
        }
    }

    /// 无效 PNG：真机存在可用语言时是基础设施失败（Err）；全无语言包的
    /// 机器上语言解析先于图片解码，返回 unavailable——两种都算通过。
    #[test]
    fn invalid_png_maps_to_infrastructure_error() {
        let available = available_language_tags();
        let available_refs: Vec<&str> = available.iter().map(String::as_str).collect();
        let english_usable =
            resolve_language_index(&language_candidates("en-US"), &available_refs).is_some();
        let outcome = run_ocr(&[0x00, 0x01, 0x02], "en-US", &[]);
        if english_usable {
            let error = outcome.expect_err("invalid PNG must fail infrastructurally");
            assert!(error.to_string().contains("OCR failed"));
        } else {
            let outcome = outcome.expect("no languages: unavailable outcome");
            assert_eq!(outcome.status, OcrStatus::Unavailable);
        }
    }
}
