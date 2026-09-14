//! 快速转换内置功能。移植自
//! `packages/built-in-plugins/quick-converter/src/index.ts`（M4 Task 5：静态单位
//! 换算与查询/体积算式解析；M4 Task 6：动态货币换算与 `toFixed(2)` 精确移植）。
//!
//! 语义保真要点：
//! - 查询模式 `CONVERSION_QUERY_PATTERN`
//!   `/^\s*(?<amount>\d+(?:\.\d+)?|\.\d+)\s*(?<unit>[A-Za-z0-9³]+|[\u4e00-\u9fff]+)\s*$/u`
//!   以手写解析等价实现（仓库未引入 regex 依赖）：`^...$` 锚定全文；`\s` 采用
//!   JS 空白集合（与 features::calculator / features::text_tools 同一集合，
//!   跨模块不互引，持私有副本）；单位段为「ASCII 字母数字 + `³`」或
//!   「U+4E00..=U+9FFF」二选一的极大 munch（与正则交替分支一致，不混排）。
//! - 金额等价 JS `Number(rawAmount)` 按最近 double 解析；超长数字串溢出为
//!   `Infinity`，由 `Number.isFinite` 等价检查拒绝。
//! - [`UNIT_ALIASES`]（49 项）逐字对齐 TS `UNIT_ALIASES` 表；查找前先
//!   `to_lowercase()`（TS `rawUnit.toLowerCase()`），表内键本就全小写。
//! - 数值格式化复用 features::calculator 的 ECMA-262 移植（不重复移植）：
//!   `formatConciseDecimal` = `normalizeNumber(value).toString()`（不做有效位
//!   舍入），`formatSignificantDecimal` = `Number(value.toPrecision(6)).toString()`。
//! - TS 侧 `assertFiniteConversionValue` 抛 RangeError、由
//!   `createStaticConversionCommand` 的 try/catch 吞掉返回 `undefined`；
//!   Rust 侧等价为格式化函数返回 `Option`，任一中间值非有限即整体 `None`（静默）。
//! - 体积算式等价 `query.trim().split(/\s*(?:\*|x|×)\s*/iu)` 手写切分
//!   （保留 JS split 的首/尾空片段语义），要求恰好 3 维、每维均为长度查询。
//! - 货币（`usd`）可被解析（kind = currency），静态命令路径恒返回 `None`
//!   （TS 中 currency 跳过静态换算落入体积算式分支，普通货币查询不匹配）。
//!   动态路径见下方 [`create_quick_converter_command`] / [`convert_currency`] /
//!   [`format_currency`]（Task 6）。
//! - 命令构造（TS `createCopyTextCommand`）：`copy-text` + payload
//!   `{ text: 标题 }`，keywords 逐字 `['quick-converter', 'converter',
//!   'conversion', <query>, <title>]`；静态路径无 subtitle，货币路径 subtitle
//!   为 `'实时汇率'|'缓存汇率' + ' · 更新时间 ' + rate.updatedAt`。

use crate::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};
use crate::features::calculator::{js_number_to_string, number_to_precision};

pub const QUICK_CONVERTER_RESULT_COMMAND_ID: &str = "quick-converter.result";
pub const QUICK_CONVERTER_PLUGIN_ID: &str = "quick-converter";

/// TS `ParsedConversionKind`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParsedConversionKind {
    Length,
    Weight,
    Currency,
    Volume,
}

impl ParsedConversionKind {
    /// TS 字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Length => "length",
            Self::Weight => "weight",
            Self::Currency => "currency",
            Self::Volume => "volume",
        }
    }
}

/// TS `ParsedConversionUnit`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ParsedConversionUnit {
    Centimeter,
    Inch,
    Millimeter,
    Meter,
    Kilogram,
    Gram,
    Pound,
    Liter,
    Milliliter,
    CubicMeter,
    CubicCentimeter,
    CubicInch,
    Usd,
}

impl ParsedConversionUnit {
    /// TS 字面量（camelCase）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Centimeter => "centimeter",
            Self::Inch => "inch",
            Self::Millimeter => "millimeter",
            Self::Meter => "meter",
            Self::Kilogram => "kilogram",
            Self::Gram => "gram",
            Self::Pound => "pound",
            Self::Liter => "liter",
            Self::Milliliter => "milliliter",
            Self::CubicMeter => "cubicMeter",
            Self::CubicCentimeter => "cubicCentimeter",
            Self::CubicInch => "cubicInch",
            Self::Usd => "usd",
        }
    }
}

/// TS `ParsedConversionQuery`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParsedConversionQuery {
    pub amount: f64,
    pub kind: ParsedConversionKind,
    pub unit: ParsedConversionUnit,
}

/// TS `ParsedVolumeDimension`。`unit` 恒为四个长度单位之一
/// （TS 以 `Extract<...>`/`as` 保证，此处以约定保证）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParsedVolumeDimension {
    pub amount: f64,
    pub unit: ParsedConversionUnit,
}

/// TS `ParsedVolumeCalculation`。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ParsedVolumeCalculation {
    pub dimensions: [ParsedVolumeDimension; 3],
}

/// TS `ExchangeRateResultSource`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExchangeRateResultSource {
    Live,
    Cache,
}

impl ExchangeRateResultSource {
    /// TS 字面量。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Cache => "cache",
        }
    }
}

/// TS `ExchangeRateResult`（Task 6 汇率接入使用）。
#[derive(Debug, Clone, PartialEq)]
pub struct ExchangeRateResult {
    pub fetched_at: String,
    pub provider: String,
    pub rate: f64,
    pub source: ExchangeRateResultSource,
    pub updated_at: String,
}

const CENTIMETERS_PER_METER: f64 = 100.0;
const CENTIMETERS_PER_INCH: f64 = 2.54;
const MILLIMETERS_PER_CENTIMETER: f64 = 10.0;
const MILLIMETERS_PER_METER: f64 = 1_000.0;
const POUNDS_PER_KILOGRAM: f64 = 2.20462;
const KILOGRAMS_PER_POUND: f64 = 0.453592;
const GRAMS_PER_KILOGRAM: f64 = 1_000.0;
const MILLILITERS_PER_LITER: f64 = 1_000.0;
const LITERS_PER_CUBIC_METER: f64 = 1_000.0;
const CUBIC_CENTIMETERS_PER_MILLILITER: f64 = 1.0;
/// TS：`CENTIMETERS_PER_INCH ** 3`。注意：JS 的 `**` 与三连乘相差 1 ulp
///（16.387064000000002 vs 16.387064）；6 位有效数字取整吸收该差异，5M 随机
/// 采样零输出差异，属不可观测的次 ulp 偏差。
const CUBIC_CENTIMETERS_PER_CUBIC_INCH: f64 =
    CENTIMETERS_PER_INCH * CENTIMETERS_PER_INCH * CENTIMETERS_PER_INCH;

/// TS `UNIT_ALIASES`（`rawUnit.toLowerCase()` 之后的键 → 单位，逐字）。
fn lookup_unit_alias(unit: &str) -> Option<ParsedConversionUnit> {
    match unit {
        "cm" | "厘米" | "公分" => Some(ParsedConversionUnit::Centimeter),
        "in" | "inch" | "inches" | "英寸" | "吋" => Some(ParsedConversionUnit::Inch),
        "mm" | "毫米" => Some(ParsedConversionUnit::Millimeter),
        "m" | "米" => Some(ParsedConversionUnit::Meter),
        "kg" | "千克" | "公斤" => Some(ParsedConversionUnit::Kilogram),
        "g" | "克" => Some(ParsedConversionUnit::Gram),
        "lb" | "lbs" | "磅" => Some(ParsedConversionUnit::Pound),
        "l" | "liter" | "liters" | "litre" | "litres" | "升" | "公升" => {
            Some(ParsedConversionUnit::Liter)
        }
        "ml" | "milliliter" | "milliliters" | "millilitre" | "millilitres" | "毫升" => {
            Some(ParsedConversionUnit::Milliliter)
        }
        "m3" | "m³" | "立方米" => Some(ParsedConversionUnit::CubicMeter),
        "cm3" | "cm³" | "cc" | "立方厘米" => Some(ParsedConversionUnit::CubicCentimeter),
        "in3" | "in³" | "inch3" | "inch³" | "cuin" | "立方英寸" => {
            Some(ParsedConversionUnit::CubicInch)
        }
        "usd" | "美元" | "美金" => Some(ParsedConversionUnit::Usd),
        _ => None,
    }
}

/// TS `parseConversionQuery`（`CONVERSION_QUERY_PATTERN` 手写等价）。
pub fn parse_conversion_query(query: &str) -> Option<ParsedConversionQuery> {
    let input: Vec<char> = query.chars().collect();
    let mut index = 0usize;

    // ^\s*
    while input.get(index).is_some_and(|c| is_js_whitespace(*c)) {
        index += 1;
    }

    // (?<amount>\d+(?:\.\d+)?|\.\d+)：先匹配 \d+(\.\d+)?，失败则回退到 \.\d+。
    let amount_start = index;
    while input.get(index).is_some_and(|c| c.is_ascii_digit()) {
        index += 1;
    }

    if index == amount_start {
        if input.get(index) == Some(&'.') {
            index += 1;
            let fraction_start = index;
            while input.get(index).is_some_and(|c| c.is_ascii_digit()) {
                index += 1;
            }
            if index == fraction_start {
                return None;
            }
        } else {
            return None;
        }
    } else if input.get(index) == Some(&'.')
        && input.get(index + 1).is_some_and(|c| c.is_ascii_digit())
    {
        // \d+\.\d+（小数点后必须有数字，否则不消费小数点，等价正则回退）。
        index += 1;
        while input.get(index).is_some_and(|c| c.is_ascii_digit()) {
            index += 1;
        }
    }

    // Number(rawAmount)：溢出得 inf，由有限性检查拒绝。
    let amount_text: String = input[amount_start..index].iter().collect();
    let amount: f64 = amount_text.parse().ok()?;
    if !amount.is_finite() {
        return None;
    }

    // \s*（金额与单位之间）。
    while input.get(index).is_some_and(|c| is_js_whitespace(*c)) {
        index += 1;
    }

    // (?<unit>[A-Za-z0-9³]+|[\u4e00-\u9fff]+)：两个字符类不相交，按首字符选分支。
    let unit_start = index;
    if input.get(index).is_some_and(|c| is_unit_char(*c)) {
        while input.get(index).is_some_and(|c| is_unit_char(*c)) {
            index += 1;
        }
    } else if input.get(index).is_some_and(|c| is_cjk_unit_char(*c)) {
        while input.get(index).is_some_and(|c| is_cjk_unit_char(*c)) {
            index += 1;
        }
    } else {
        return None;
    }
    let unit_text: String = input[unit_start..index].iter().collect();

    // \s*$
    while input.get(index).is_some_and(|c| is_js_whitespace(*c)) {
        index += 1;
    }
    if index != input.len() {
        return None;
    }

    // UNIT_ALIASES.get(rawUnit.toLowerCase())
    let unit = lookup_unit_alias(&unit_text.to_lowercase())?;

    Some(ParsedConversionQuery {
        amount,
        kind: get_unit_kind(unit),
        unit,
    })
}

/// TS `createStaticConversionCommand`：静态（非货币）换算或体积算式；
/// 中间结果非有限（TS 抛 RangeError 被 try/catch 吞掉）时返回 `None`。
pub fn create_static_conversion_command(query: &str) -> Option<Command> {
    let parsed = parse_conversion_query(query);

    if let Some(parsed) = parsed.filter(|parsed| parsed.kind != ParsedConversionKind::Currency) {
        return create_copy_text_command(format_static_conversion(&parsed)?, query, None);
    }

    let volume_calculation = parse_volume_calculation(query)?;

    create_copy_text_command(format_volume_calculation(&volume_calculation)?, query, None)
}

/// TS `createQuickConverterCommand` 的同步移植：静态命令优先；货币查询用注入的
/// 汇率结果构造命令。TS 为 async（`await getUsdToCnyRate(...)`，provider 抛错
/// 折叠为 undefined），Rust 由调用方先取得 `Option<ExchangeRateResult>` 再注入
/// ——provider 缺失/抛错 → `None`（语义等价）。
///
/// 校验链逐字（index.ts:188-200）：rate 为 `None`、`!Number.isFinite(rate.rate)`、
/// `rate.rate <= 0`、乘积非有限 → 任一命中返回 `None`。
pub fn create_quick_converter_command(
    query: &str,
    rate: Option<&ExchangeRateResult>,
) -> Option<Command> {
    if let Some(command) = create_static_conversion_command(query) {
        return Some(command);
    }

    let parsed = parse_conversion_query(query)?;

    if parsed.kind != ParsedConversionKind::Currency {
        return None;
    }

    let rate = rate?;
    let converted_amount = convert_currency(parsed.amount, "USD", "CNY", Some(rate)).ok()?;

    let title = format!(
        "{} 美元 ≈ {} 人民币",
        format_concise_decimal(parsed.amount)?,
        format_currency(converted_amount)?,
    );
    let subtitle = format!(
        "{} · 更新时间 {}",
        if rate.source == ExchangeRateResultSource::Live {
            "实时汇率"
        } else {
            "缓存汇率"
        },
        rate.updated_at,
    );

    create_copy_text_command(title, query, Some(subtitle))
}

/// [`convert_currency`] 的失败判别。TS 把所有失败折叠为 `undefined`（返回
/// 无命令），Rust 拆分为可判别的错误以便测试与上层诊断；命令层用 `.ok()?`
/// 恢复 TS 折叠语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvertCurrencyError {
    /// TS 无 from/to 概念（货币路径硬编码 USD→CNY）；Rust 暴露参数后，
    /// 非 USD/CNY 货币对返回此错误（大小写不敏感，对齐单位别名的小写归一）。
    UnsupportedPair,
    /// TS `rate === undefined`（provider 缺失/抛错/离线无缓存）。
    RateUnavailable,
    /// TS `!Number.isFinite(rate.rate) || rate.rate <= 0`。
    InvalidRate,
    /// TS `!Number.isFinite(convertedAmount)`（amount × rate 溢出为 ±inf
    /// 或产生 NaN）。
    ConversionNotFinite,
}

/// 货币转换纯函数。TS `createQuickConverterCommand` 货币路径的查找规则本就
/// 不是 rates 表：provider 只提供单一 USD→CNY 汇率，目标货币硬编码 CNY
/// （标题「人民币」），故 `from`/`to` 仅接受 USD/CNY（其余货币对返回
/// [`ConvertCurrencyError::UnsupportedPair`]，TS 中不存在该路径）。
///
/// 校验顺序逐字 TS（index.ts:190-198）：rate 缺失 → rate 非有限/非正 →
/// 乘积非有限。`amount` 的有限性由解析层保证（解析器拒绝溢出金额），此处
/// 不重复校验——非有限 amount 会落入乘积检查（与 TS 的最终 finite 检查一致）。
pub fn convert_currency(
    amount: f64,
    from: &str,
    to: &str,
    rate: Option<&ExchangeRateResult>,
) -> Result<f64, ConvertCurrencyError> {
    if !from.eq_ignore_ascii_case("usd") || !to.eq_ignore_ascii_case("cny") {
        return Err(ConvertCurrencyError::UnsupportedPair);
    }

    let Some(rate) = rate else {
        return Err(ConvertCurrencyError::RateUnavailable);
    };

    if !rate.rate.is_finite() || rate.rate <= 0.0 {
        return Err(ConvertCurrencyError::InvalidRate);
    }

    let converted_amount = amount * rate.rate;

    if !converted_amount.is_finite() {
        return Err(ConvertCurrencyError::ConversionNotFinite);
    }

    Ok(converted_amount)
}

/// TS `parseVolumeCalculation`。
pub fn parse_volume_calculation(query: &str) -> Option<ParsedVolumeCalculation> {
    let parts = split_volume_expression(js_trim(query));

    if parts.len() != 3 {
        return None;
    }

    let dimensions = parts
        .iter()
        .map(|part| parse_volume_dimension(part))
        .collect::<Option<Vec<_>>>()?;

    Some(ParsedVolumeCalculation {
        dimensions: [dimensions[0], dimensions[1], dimensions[2]],
    })
}

/// TS `parseVolumeDimension`：维度必须解析为长度查询。
fn parse_volume_dimension(query: &str) -> Option<ParsedVolumeDimension> {
    let parsed = parse_conversion_query(query)?;

    if parsed.kind != ParsedConversionKind::Length {
        return None;
    }

    Some(ParsedVolumeDimension {
        amount: parsed.amount,
        unit: parsed.unit,
    })
}

/// TS `getUnitKind`。
fn get_unit_kind(unit: ParsedConversionUnit) -> ParsedConversionKind {
    match unit {
        ParsedConversionUnit::Centimeter
        | ParsedConversionUnit::Inch
        | ParsedConversionUnit::Millimeter
        | ParsedConversionUnit::Meter => ParsedConversionKind::Length,
        ParsedConversionUnit::Kilogram
        | ParsedConversionUnit::Gram
        | ParsedConversionUnit::Pound => ParsedConversionKind::Weight,
        ParsedConversionUnit::Liter
        | ParsedConversionUnit::Milliliter
        | ParsedConversionUnit::CubicMeter
        | ParsedConversionUnit::CubicCentimeter
        | ParsedConversionUnit::CubicInch => ParsedConversionKind::Volume,
        ParsedConversionUnit::Usd => ParsedConversionKind::Currency,
    }
}

/// TS `formatStaticConversion`。currency 分支 TS 返回 `''`，但调用方保证不进入；
/// Rust 以 `None` 表达（不可达路径静默）。
fn format_static_conversion(parsed: &ParsedConversionQuery) -> Option<String> {
    match parsed.kind {
        ParsedConversionKind::Length => format_length_conversion(parsed),
        ParsedConversionKind::Weight => format_weight_conversion(parsed),
        ParsedConversionKind::Volume => format_volume_conversion(parsed),
        ParsedConversionKind::Currency => None,
    }
}

/// TS `formatLengthConversion`（运算顺序逐字保留，浮点结果与 JS 一致）。
fn format_length_conversion(parsed: &ParsedConversionQuery) -> Option<String> {
    let amount = parsed.amount;
    match parsed.unit {
        ParsedConversionUnit::Centimeter => Some(format!(
            "{} 厘米 = {} 毫米 = {} 米 = {} 英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount * MILLIMETERS_PER_CENTIMETER)?,
            format_significant_decimal(amount / CENTIMETERS_PER_METER)?,
            format_significant_decimal(amount / CENTIMETERS_PER_INCH)?,
        )),
        ParsedConversionUnit::Inch => {
            let centimeters = amount * CENTIMETERS_PER_INCH;

            Some(format!(
                "{} 英寸 = {} 厘米 = {} 毫米 = {} 米",
                format_concise_decimal(amount)?,
                format_significant_decimal(centimeters)?,
                format_significant_decimal(centimeters * MILLIMETERS_PER_CENTIMETER)?,
                format_significant_decimal(centimeters / CENTIMETERS_PER_METER)?,
            ))
        }
        ParsedConversionUnit::Millimeter => Some(format!(
            "{} 毫米 = {} 厘米 = {} 米 = {} 英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount / MILLIMETERS_PER_CENTIMETER)?,
            format_significant_decimal(amount / MILLIMETERS_PER_METER)?,
            format_significant_decimal(amount / MILLIMETERS_PER_CENTIMETER / CENTIMETERS_PER_INCH)?,
        )),
        ParsedConversionUnit::Meter => Some(format!(
            "{} 米 = {} 厘米 = {} 毫米 = {} 英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount * CENTIMETERS_PER_METER)?,
            format_significant_decimal(amount * MILLIMETERS_PER_METER)?,
            format_significant_decimal((amount * CENTIMETERS_PER_METER) / CENTIMETERS_PER_INCH)?,
        )),
        _ => None,
    }
}

/// TS `formatVolumeCalculation`。
fn format_volume_calculation(parsed: &ParsedVolumeCalculation) -> Option<String> {
    // TS：dimensions.map(...).reduce((volume, length) => volume * length, 1)。
    let mut cubic_centimeters = 1.0f64;
    for dimension in &parsed.dimensions {
        cubic_centimeters *= convert_length_to_centimeters(dimension);
    }

    let formatted_dimensions = parsed
        .dimensions
        .iter()
        .map(format_length_dimension)
        .collect::<Option<Vec<_>>>()?;

    Some(format!(
        "{} = {}",
        formatted_dimensions.join(" × "),
        format_volume_from_cubic_centimeters(cubic_centimeters)?,
    ))
}

/// TS `formatLengthDimension`。
fn format_length_dimension(dimension: &ParsedVolumeDimension) -> Option<String> {
    let amount = format_concise_decimal(dimension.amount)?;
    match dimension.unit {
        ParsedConversionUnit::Centimeter => Some(format!("{amount} 厘米")),
        ParsedConversionUnit::Inch => Some(format!("{amount} 英寸")),
        ParsedConversionUnit::Millimeter => Some(format!("{amount} 毫米")),
        ParsedConversionUnit::Meter => Some(format!("{amount} 米")),
        _ => None,
    }
}

/// TS `convertLengthToCentimeters`。
fn convert_length_to_centimeters(dimension: &ParsedVolumeDimension) -> f64 {
    match dimension.unit {
        ParsedConversionUnit::Centimeter => dimension.amount,
        ParsedConversionUnit::Inch => dimension.amount * CENTIMETERS_PER_INCH,
        ParsedConversionUnit::Millimeter => dimension.amount / MILLIMETERS_PER_CENTIMETER,
        ParsedConversionUnit::Meter => dimension.amount * CENTIMETERS_PER_METER,
        _ => unreachable!("volume dimensions are validated to be length units"),
    }
}

/// TS `formatVolumeConversion`。
fn format_volume_conversion(parsed: &ParsedConversionQuery) -> Option<String> {
    let amount = parsed.amount;
    match parsed.unit {
        ParsedConversionUnit::Liter => Some(format!(
            "{} 升 = {} 毫升 = {} 立方米 = {} 立方厘米 = {} 立方英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount * MILLILITERS_PER_LITER)?,
            format_significant_decimal(amount / LITERS_PER_CUBIC_METER)?,
            format_significant_decimal(
                amount * MILLILITERS_PER_LITER * CUBIC_CENTIMETERS_PER_MILLILITER
            )?,
            format_significant_decimal(
                (amount * MILLILITERS_PER_LITER * CUBIC_CENTIMETERS_PER_MILLILITER)
                    / CUBIC_CENTIMETERS_PER_CUBIC_INCH
            )?,
        )),
        ParsedConversionUnit::Milliliter => Some(format!(
            "{} 毫升 = {} 升 = {} 立方厘米 = {} 立方米 = {} 立方英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount / MILLILITERS_PER_LITER)?,
            format_significant_decimal(amount * CUBIC_CENTIMETERS_PER_MILLILITER)?,
            format_significant_decimal(amount / MILLILITERS_PER_LITER / LITERS_PER_CUBIC_METER)?,
            format_significant_decimal(
                (amount * CUBIC_CENTIMETERS_PER_MILLILITER) / CUBIC_CENTIMETERS_PER_CUBIC_INCH
            )?,
        )),
        ParsedConversionUnit::CubicMeter => Some(format!(
            "{} 立方米 = {} 升 = {} 毫升 = {} 立方厘米 = {} 立方英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount * LITERS_PER_CUBIC_METER)?,
            format_significant_decimal(amount * LITERS_PER_CUBIC_METER * MILLILITERS_PER_LITER)?,
            format_significant_decimal(
                amount
                    * LITERS_PER_CUBIC_METER
                    * MILLILITERS_PER_LITER
                    * CUBIC_CENTIMETERS_PER_MILLILITER
            )?,
            format_significant_decimal(
                (amount
                    * LITERS_PER_CUBIC_METER
                    * MILLILITERS_PER_LITER
                    * CUBIC_CENTIMETERS_PER_MILLILITER)
                    / CUBIC_CENTIMETERS_PER_CUBIC_INCH
            )?,
        )),
        ParsedConversionUnit::CubicCentimeter => Some(format!(
            "{} 立方厘米 = {} 毫升 = {} 升 = {} 立方米 = {} 立方英寸",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount / CUBIC_CENTIMETERS_PER_MILLILITER)?,
            format_significant_decimal(
                amount / CUBIC_CENTIMETERS_PER_MILLILITER / MILLILITERS_PER_LITER
            )?,
            format_significant_decimal(
                amount
                    / CUBIC_CENTIMETERS_PER_MILLILITER
                    / MILLILITERS_PER_LITER
                    / LITERS_PER_CUBIC_METER
            )?,
            format_significant_decimal(amount / CUBIC_CENTIMETERS_PER_CUBIC_INCH)?,
        )),
        ParsedConversionUnit::CubicInch => {
            let cubic_centimeters = amount * CUBIC_CENTIMETERS_PER_CUBIC_INCH;

            Some(format!(
                "{} 立方英寸 = {} 立方厘米 = {} 毫升 = {} 升 = {} 立方米",
                format_concise_decimal(amount)?,
                format_significant_decimal(cubic_centimeters)?,
                format_significant_decimal(cubic_centimeters / CUBIC_CENTIMETERS_PER_MILLILITER)?,
                format_significant_decimal(
                    cubic_centimeters / CUBIC_CENTIMETERS_PER_MILLILITER / MILLILITERS_PER_LITER
                )?,
                format_significant_decimal(
                    cubic_centimeters
                        / CUBIC_CENTIMETERS_PER_MILLILITER
                        / MILLILITERS_PER_LITER
                        / LITERS_PER_CUBIC_METER
                )?,
            ))
        }
        _ => None,
    }
}

/// TS `formatVolumeFromCubicCentimeters`。
fn format_volume_from_cubic_centimeters(cubic_centimeters: f64) -> Option<String> {
    Some(format!(
        "{} 立方厘米 = {} 毫升 = {} 升 = {} 立方米 = {} 立方英寸",
        format_significant_decimal(cubic_centimeters)?,
        format_significant_decimal(cubic_centimeters / CUBIC_CENTIMETERS_PER_MILLILITER)?,
        format_significant_decimal(
            cubic_centimeters / CUBIC_CENTIMETERS_PER_MILLILITER / MILLILITERS_PER_LITER
        )?,
        format_significant_decimal(
            cubic_centimeters
                / CUBIC_CENTIMETERS_PER_MILLILITER
                / MILLILITERS_PER_LITER
                / LITERS_PER_CUBIC_METER
        )?,
        format_significant_decimal(cubic_centimeters / CUBIC_CENTIMETERS_PER_CUBIC_INCH)?,
    ))
}

/// TS `formatWeightConversion`。
fn format_weight_conversion(parsed: &ParsedConversionQuery) -> Option<String> {
    let amount = parsed.amount;
    match parsed.unit {
        ParsedConversionUnit::Kilogram => Some(format!(
            "{} 千克 = {} 磅",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount * POUNDS_PER_KILOGRAM)?,
        )),
        ParsedConversionUnit::Gram => Some(format!(
            "{} 克 = {} 磅",
            format_concise_decimal(amount)?,
            format_significant_decimal((amount / GRAMS_PER_KILOGRAM) * POUNDS_PER_KILOGRAM)?,
        )),
        ParsedConversionUnit::Pound => Some(format!(
            "{} 磅 = {} 千克 = {} 克",
            format_concise_decimal(amount)?,
            format_significant_decimal(amount * KILOGRAMS_PER_POUND)?,
            format_significant_decimal(amount * KILOGRAMS_PER_POUND * GRAMS_PER_KILOGRAM)?,
        )),
        _ => None,
    }
}

/// TS `createCopyTextCommand`（静态路径 subtitle 为 undefined，货币路径携带）。
fn create_copy_text_command(
    title: String,
    query: &str,
    subtitle: Option<String>,
) -> Option<Command> {
    let mut payload = CommandPayload::new();
    payload.insert("text".into(), title.clone().into());

    Some(Command {
        id: QUICK_CONVERTER_RESULT_COMMAND_ID.to_string(),
        source: CommandSource::Plugin,
        title: title.clone(),
        subtitle,
        keywords: vec![
            "quick-converter".to_string(),
            "converter".to_string(),
            "conversion".to_string(),
            query.to_string(),
            title,
        ],
        icon: None,
        plugin_id: Some(QUICK_CONVERTER_PLUGIN_ID.to_string()),
        action: CommandAction {
            action_type: CommandActionType::CopyText,
            payload,
        },
    })
}

/// TS `formatConciseDecimal`：`normalizeNumber(value).toString()`（无有效位舍入）。
fn format_concise_decimal(value: f64) -> Option<String> {
    assert_finite_conversion_value(value)?;
    Some(js_number_to_string(normalize_number(value)))
}

/// TS `formatSignificantDecimal`：`Number(value.toPrecision(6)).toString()`。
fn format_significant_decimal(value: f64) -> Option<String> {
    assert_finite_conversion_value(value)?;
    Some(js_number_to_string(number_to_precision(value, 6)))
}

/// TS `formatCurrency`：`value.toFixed(2)`（ECMA-262 `Number.prototype.toFixed`，
/// f = 2）的精确移植。
///
/// 规范语义：取整数 n 使 `n / 100 - |x|` 最接近零，**平局取较大的 n**
/// （十进制"五入"）。与 Rust `{:.2}`（精确十进制展开 + 平局舍入到偶）的差异
/// **仅在精确平局**：精确平局 ⟺ |x| = M/8 且 M 为奇整数（此时 1000|x| =
/// M·125 为奇整数，第 3 位小数恰为 5 且其后全零）。判定利用 ×2³ 是无精度
/// 损失的幂次缩放：`|x|·8` 为奇整数 ⟺ 精确平局。非平局时 Rust `{:.2}` 的
/// 精确舍入与 JS 逐字一致（半偶规则在非平局值上不触发）。
///
/// |x| ≥ 1e21 时 toFixed 返回 `Number::toString(x)`（ECMA 步骤 5-6，负号由
/// toString 自带）。非有限值对齐 TS `assertFiniteConversionValue` 抛
/// RangeError 被吞 → `None`。
fn format_currency(value: f64) -> Option<String> {
    assert_finite_conversion_value(value)?;

    let sign = if value < 0.0 { "-" } else { "" };
    let magnitude = value.abs();

    if magnitude >= 1e21 {
        return Some(format!("{sign}{}", js_number_to_string(magnitude)));
    }

    // 精确平局检测：|x|·8 是 [0, 2^53) 内的奇整数。≥ 2^53 的整数既不可能是
    // 平局（平局要求 |x| = M/8、M ≤ 2^53），f64 大整数的 fract 恒为 0 也无
    // 判定意义，一并排除。
    let scaled = magnitude * 8.0;
    let is_exact_tie =
        scaled.fract() == 0.0 && scaled < 9_007_199_254_740_992.0 && (scaled as u64) % 2 == 1;

    if !is_exact_tie {
        return Some(format!("{sign}{magnitude:.2}"));
    }

    // |x| = M/8 = M·125/1000，x·100 恰为半整数 M·25/2；平局取较大
    // n = ⌈M·25 / 2⌉（M 奇 ⇒ M·25 奇 ⇒ 向上取整即 +1 除 2）。
    let m = scaled as u64;
    let n = (m * 25).div_ceil(2);

    Some(format!("{sign}{}.{:02}", n / 100, n % 100))
}

/// TS `assertFiniteConversionValue`：非有限值抛 RangeError（被调用方 try/catch
/// 折叠为 undefined）；Rust 以 `None` 表达。
fn assert_finite_conversion_value(value: f64) -> Option<()> {
    if value.is_finite() {
        Some(())
    } else {
        None
    }
}

/// TS `normalizeNumber`：`Object.is(value, -0) ? 0 : value`。
fn normalize_number(value: f64) -> f64 {
    if value == 0.0 && value.is_sign_negative() {
        0.0
    } else {
        value
    }
}

/// 等价粘性正则 `/\s*(?:\*|x|×)\s*/iu` 自 `start` 起的一次匹配，
/// 返回匹配结束字节位置（`/i` 使 `x` 大小写均可，`×` 无大小写）。
fn match_volume_separator(input: &str, start: usize) -> Option<usize> {
    let mut index = start;

    while let Some((character, size)) = char_at(input, index) {
        if is_js_whitespace(character) {
            index += size;
        } else {
            break;
        }
    }

    let (separator, size) = char_at(input, index)?;
    if !matches!(separator, '*' | 'x' | 'X' | '×') {
        return None;
    }
    index += size;

    while let Some((character, size)) = char_at(input, index) {
        if is_js_whitespace(character) {
            index += size;
        } else {
            break;
        }
    }

    Some(index)
}

/// 等价 `String.prototype.split(/\s*(?:\*|x|×)\s*/iu)`：保留 JS split 的
/// 首/尾空片段语义（如 `"x1x"` → `["", "1"]`），非匹配字符逐字累积。
fn split_volume_expression(input: &str) -> Vec<&str> {
    let mut parts: Vec<&str> = Vec::new();
    let mut part_start = 0usize;
    let mut index = 0usize;

    while index < input.len() {
        if let Some(end) = match_volume_separator(input, index) {
            parts.push(&input[part_start..index]);
            index = end;
            part_start = end;
        } else {
            index += char_at(input, index).map_or(1, |(_, size)| size);
        }
    }

    parts.push(&input[part_start..]);
    parts
}

fn char_at(input: &str, index: usize) -> Option<(char, usize)> {
    let character = input[index..].chars().next()?;
    Some((character, character.len_utf8()))
}

/// JS 正则字符类 `[A-Za-z0-9³]`（与 [`is_cjk_unit_char`] 命名对齐；³ 为
/// U+00B3，非 ASCII，故名称不带 ascii）。
fn is_unit_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || value == '\u{00B3}'
}

fn is_cjk_unit_char(value: char) -> bool {
    matches!(value, '\u{4E00}'..='\u{9FFF}')
}

/// JS 正则 `/\s/` 的空白集合（与 `char::is_whitespace` 不同：多 `\u{FEFF}`、
/// 缺 `\u{85}`；跨模块与 calculator/text_tools 同集合、各持私有副本）。
fn is_js_whitespace(value: char) -> bool {
    matches!(
        value,
        ' ' | '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JS `String.prototype.trim()`（ECMAScript 空白集合）。
fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::CommandActionType;

    // ---- packages/built-in-plugins/quick-converter/src/quickConverter.test.ts ----

    fn static_command_title(query: &str) -> Option<String> {
        create_static_conversion_command(query).map(|command| command.title)
    }

    #[test]
    fn converts_length_queries() {
        let cases: &[(&str, &str)] = &[
            ("1厘米", "1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸"),
            ("1 cm", "1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸"),
            ("1公分", "1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸"),
            ("25毫米", "25 毫米 = 2.5 厘米 = 0.025 米 = 0.984252 英寸"),
            ("2.5 m", "2.5 米 = 250 厘米 = 2500 毫米 = 98.4252 英寸"),
            ("1 inch", "1 英寸 = 2.54 厘米 = 25.4 毫米 = 0.0254 米"),
            ("2英寸", "2 英寸 = 5.08 厘米 = 50.8 毫米 = 0.0508 米"),
        ];

        for (query, expected) in cases {
            assert_eq!(
                static_command_title(query),
                Some((*expected).to_string()),
                "unexpected title for {query:?}"
            );
        }
    }

    #[test]
    fn converts_weight_queries() {
        let cases: &[(&str, &str)] = &[
            ("1千克", "1 千克 = 2.20462 磅"),
            ("1公斤", "1 千克 = 2.20462 磅"),
            ("1000g", "1000 克 = 2.20462 磅"),
            ("1 lb", "1 磅 = 0.453592 千克 = 453.592 克"),
        ];

        for (query, expected) in cases {
            assert_eq!(static_command_title(query), Some((*expected).to_string()));
        }
    }

    #[test]
    fn converts_volume_queries() {
        let cases: &[(&str, &str)] = &[
            (
                "1升",
                "1 升 = 1000 毫升 = 0.001 立方米 = 1000 立方厘米 = 61.0237 立方英寸",
            ),
            (
                "1 L",
                "1 升 = 1000 毫升 = 0.001 立方米 = 1000 立方厘米 = 61.0237 立方英寸",
            ),
            (
                "500毫升",
                "500 毫升 = 0.5 升 = 500 立方厘米 = 0.0005 立方米 = 30.5119 立方英寸",
            ),
            (
                "2 m3",
                "2 立方米 = 2000 升 = 2000000 毫升 = 2000000 立方厘米 = 122047 立方英寸",
            ),
            (
                "2m³",
                "2 立方米 = 2000 升 = 2000000 毫升 = 2000000 立方厘米 = 122047 立方英寸",
            ),
            (
                "250cm3",
                "250 立方厘米 = 250 毫升 = 0.25 升 = 0.00025 立方米 = 15.2559 立方英寸",
            ),
            (
                "250cc",
                "250 立方厘米 = 250 毫升 = 0.25 升 = 0.00025 立方米 = 15.2559 立方英寸",
            ),
            (
                "1 in3",
                "1 立方英寸 = 16.3871 立方厘米 = 16.3871 毫升 = 0.0163871 升 = 0.0000163871 立方米",
            ),
            (
                "1in³",
                "1 立方英寸 = 16.3871 立方厘米 = 16.3871 毫升 = 0.0163871 升 = 0.0000163871 立方米",
            ),
            (
                "1立方英寸",
                "1 立方英寸 = 16.3871 立方厘米 = 16.3871 毫升 = 0.0163871 升 = 0.0000163871 立方米",
            ),
        ];

        for (query, expected) in cases {
            assert_eq!(static_command_title(query), Some((*expected).to_string()));
        }
    }

    #[test]
    fn calculates_volume_expressions() {
        let cases: &[(&str, &str)] = &[
            (
                "1cm * 1cm *1 cm",
                "1 厘米 × 1 厘米 × 1 厘米 = 1 立方厘米 = 1 毫升 = 0.001 升 = 0.000001 立方米 = 0.0610237 立方英寸",
            ),
            (
                "10 cm x 20 cm x 3 cm",
                "10 厘米 × 20 厘米 × 3 厘米 = 600 立方厘米 = 600 毫升 = 0.6 升 = 0.0006 立方米 = 36.6142 立方英寸",
            ),
            (
                "1m × 20cm × 30mm",
                "1 米 × 20 厘米 × 30 毫米 = 6000 立方厘米 = 6000 毫升 = 6 升 = 0.006 立方米 = 366.142 立方英寸",
            ),
            (
                "1in * 2in * 3in",
                "1 英寸 × 2 英寸 × 3 英寸 = 98.3224 立方厘米 = 98.3224 毫升 = 0.0983224 升 = 0.0000983224 立方米 = 6 立方英寸",
            ),
            (
                "40cm*40cm*50cm",
                "40 厘米 × 40 厘米 × 50 厘米 = 80000 立方厘米 = 80000 毫升 = 80 升 = 0.08 立方米 = 4881.9 立方英寸",
            ),
        ];

        for (query, expected) in cases {
            assert_eq!(static_command_title(query), Some((*expected).to_string()));
        }
    }

    #[test]
    fn parses_supported_alias_queries() {
        let cases: &[(&str, f64, ParsedConversionKind, ParsedConversionUnit)] = &[
            (
                "1厘米",
                1.0,
                ParsedConversionKind::Length,
                ParsedConversionUnit::Centimeter,
            ),
            (
                "1 mm",
                1.0,
                ParsedConversionKind::Length,
                ParsedConversionUnit::Millimeter,
            ),
            (
                "1米",
                1.0,
                ParsedConversionKind::Length,
                ParsedConversionUnit::Meter,
            ),
            (
                "1 in",
                1.0,
                ParsedConversionKind::Length,
                ParsedConversionUnit::Inch,
            ),
            (
                "1 inch",
                1.0,
                ParsedConversionKind::Length,
                ParsedConversionUnit::Inch,
            ),
            (
                "1英寸",
                1.0,
                ParsedConversionKind::Length,
                ParsedConversionUnit::Inch,
            ),
            (
                "2.5kg",
                2.5,
                ParsedConversionKind::Weight,
                ParsedConversionUnit::Kilogram,
            ),
            (
                "100 克",
                100.0,
                ParsedConversionKind::Weight,
                ParsedConversionUnit::Gram,
            ),
            (
                "1 lbs",
                1.0,
                ParsedConversionKind::Weight,
                ParsedConversionUnit::Pound,
            ),
            (
                "1升",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::Liter,
            ),
            (
                "1 ml",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::Milliliter,
            ),
            (
                "1立方米",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicMeter,
            ),
            (
                "1 m3",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicMeter,
            ),
            (
                "1 m³",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicMeter,
            ),
            (
                "1立方厘米",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicCentimeter,
            ),
            (
                "1 cm3",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicCentimeter,
            ),
            (
                "1 cm³",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicCentimeter,
            ),
            (
                "1 cc",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicCentimeter,
            ),
            (
                "1 in3",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicInch,
            ),
            (
                "1 in³",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicInch,
            ),
            (
                "1 inch3",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicInch,
            ),
            (
                "1立方英寸",
                1.0,
                ParsedConversionKind::Volume,
                ParsedConversionUnit::CubicInch,
            ),
            (
                "1 USD",
                1.0,
                ParsedConversionKind::Currency,
                ParsedConversionUnit::Usd,
            ),
            (
                "1美元",
                1.0,
                ParsedConversionKind::Currency,
                ParsedConversionUnit::Usd,
            ),
            (
                "1美金",
                1.0,
                ParsedConversionKind::Currency,
                ParsedConversionUnit::Usd,
            ),
        ];

        for (query, amount, kind, unit) in cases {
            let parsed = parse_conversion_query(query).expect("query should parse");
            assert_eq!(parsed.amount, *amount, "unexpected amount for {query:?}");
            assert_eq!(parsed.kind, *kind, "unexpected kind for {query:?}");
            assert_eq!(parsed.unit, *unit, "unexpected unit for {query:?}");
        }
    }

    #[test]
    fn rejects_unsupported_queries() {
        for query in ["1kg + 2g", "人民币换美元", "一美元", "abc", "", "1"] {
            assert_eq!(
                parse_conversion_query(query),
                None,
                "expected None for {query:?}"
            );
            assert_eq!(
                create_static_conversion_command(query),
                None,
                "expected no command for {query:?}"
            );
        }
    }

    #[test]
    fn currency_query_yields_no_static_command() {
        // TS：currency 跳过静态换算分支；汇率命令由 Task 6 提供。
        let parsed = parse_conversion_query("1美元").expect("currency query should parse");
        assert_eq!(parsed.kind, ParsedConversionKind::Currency);
        assert_eq!(parsed.unit, ParsedConversionUnit::Usd);
        assert_eq!(create_static_conversion_command("1美元"), None);
        assert_eq!(create_static_conversion_command("2 USD"), None);
    }

    #[test]
    fn rejects_static_conversions_whose_intermediate_results_overflow() {
        // TS：'1'.padEnd(308, '0') + '米' → 1e307（amount 有限），米→英寸的
        // 中间结果溢出 → try/catch → undefined。
        let query = format!("{}{}米", "1", "0".repeat(307));
        let parsed = parse_conversion_query(&query).expect("amount itself stays finite");
        assert_eq!(parsed.kind, ParsedConversionKind::Length);
        assert_eq!(parsed.unit, ParsedConversionUnit::Meter);
        assert_eq!(create_static_conversion_command(&query), None);
    }

    #[test]
    fn rejects_queries_whose_amount_overflows_to_infinity() {
        let query = format!("{}米", "9".repeat(400));
        assert_eq!(parse_conversion_query(&query), None);
        assert_eq!(create_static_conversion_command(&query), None);
    }

    #[test]
    fn creates_copy_text_command_shape() {
        let command = create_static_conversion_command("1厘米").expect("command for length query");

        assert_eq!(command.id, "quick-converter.result");
        assert_eq!(command.source, CommandSource::Plugin);
        assert_eq!(command.title, "1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸");
        assert_eq!(command.subtitle, None);
        assert_eq!(command.plugin_id.as_deref(), Some("quick-converter"));
        assert_eq!(
            command.keywords,
            vec![
                "quick-converter".to_string(),
                "converter".to_string(),
                "conversion".to_string(),
                "1厘米".to_string(),
                command.title.clone(),
            ]
        );
        assert_eq!(command.action.action_type, CommandActionType::CopyText);
        assert_eq!(
            command
                .action
                .payload
                .get("text")
                .and_then(|value| value.as_str()),
            Some(command.title.as_str())
        );
    }

    // ---- 别名全表（index.ts UNIT_ALIASES 逐项，含大小写归一） ----

    #[test]
    fn resolves_every_alias_in_the_table() {
        let aliases: &[(&str, ParsedConversionUnit)] = &[
            ("cm", ParsedConversionUnit::Centimeter),
            ("厘米", ParsedConversionUnit::Centimeter),
            ("公分", ParsedConversionUnit::Centimeter),
            ("in", ParsedConversionUnit::Inch),
            ("inch", ParsedConversionUnit::Inch),
            ("inches", ParsedConversionUnit::Inch),
            ("英寸", ParsedConversionUnit::Inch),
            ("吋", ParsedConversionUnit::Inch),
            ("mm", ParsedConversionUnit::Millimeter),
            ("毫米", ParsedConversionUnit::Millimeter),
            ("m", ParsedConversionUnit::Meter),
            ("米", ParsedConversionUnit::Meter),
            ("kg", ParsedConversionUnit::Kilogram),
            ("千克", ParsedConversionUnit::Kilogram),
            ("公斤", ParsedConversionUnit::Kilogram),
            ("g", ParsedConversionUnit::Gram),
            ("克", ParsedConversionUnit::Gram),
            ("lb", ParsedConversionUnit::Pound),
            ("lbs", ParsedConversionUnit::Pound),
            ("磅", ParsedConversionUnit::Pound),
            ("l", ParsedConversionUnit::Liter),
            ("liter", ParsedConversionUnit::Liter),
            ("liters", ParsedConversionUnit::Liter),
            ("litre", ParsedConversionUnit::Liter),
            ("litres", ParsedConversionUnit::Liter),
            ("升", ParsedConversionUnit::Liter),
            ("公升", ParsedConversionUnit::Liter),
            ("ml", ParsedConversionUnit::Milliliter),
            ("milliliter", ParsedConversionUnit::Milliliter),
            ("milliliters", ParsedConversionUnit::Milliliter),
            ("millilitre", ParsedConversionUnit::Milliliter),
            ("millilitres", ParsedConversionUnit::Milliliter),
            ("毫升", ParsedConversionUnit::Milliliter),
            ("m3", ParsedConversionUnit::CubicMeter),
            ("m³", ParsedConversionUnit::CubicMeter),
            ("立方米", ParsedConversionUnit::CubicMeter),
            ("cm3", ParsedConversionUnit::CubicCentimeter),
            ("cm³", ParsedConversionUnit::CubicCentimeter),
            ("cc", ParsedConversionUnit::CubicCentimeter),
            ("立方厘米", ParsedConversionUnit::CubicCentimeter),
            ("in3", ParsedConversionUnit::CubicInch),
            ("in³", ParsedConversionUnit::CubicInch),
            ("inch3", ParsedConversionUnit::CubicInch),
            ("inch³", ParsedConversionUnit::CubicInch),
            ("cuin", ParsedConversionUnit::CubicInch),
            ("立方英寸", ParsedConversionUnit::CubicInch),
            ("usd", ParsedConversionUnit::Usd),
            ("美元", ParsedConversionUnit::Usd),
            ("美金", ParsedConversionUnit::Usd),
        ];

        assert_eq!(aliases.len(), 49);
        for (alias, unit) in aliases {
            let query = format!("1{alias}");
            let parsed = parse_conversion_query(&query)
                .unwrap_or_else(|| panic!("alias {alias:?} should parse"));
            assert_eq!(parsed.unit, *unit, "unexpected unit for alias {alias:?}");
            assert_eq!(parsed.amount, 1.0);
        }
    }

    #[test]
    fn lowercases_the_unit_before_lookup() {
        // TS：UNIT_ALIASES.get(rawUnit.toLowerCase())。
        assert_eq!(
            parse_conversion_query("1 MM").map(|parsed| parsed.unit),
            Some(ParsedConversionUnit::Millimeter)
        );
        assert_eq!(
            parse_conversion_query("1 LbS").map(|parsed| parsed.unit),
            Some(ParsedConversionUnit::Pound)
        );
        assert_eq!(
            parse_conversion_query("1 CM³").map(|parsed| parsed.unit),
            Some(ParsedConversionUnit::CubicCentimeter)
        );
        assert_eq!(
            parse_conversion_query("1 CUIN").map(|parsed| parsed.unit),
            Some(ParsedConversionUnit::CubicInch)
        );
    }

    // ---- 解析细节（手写解析器等价正则的补充锁定） ----

    #[test]
    fn parses_amount_without_leading_digit() {
        let parsed = parse_conversion_query(".5 m").expect(".5 should parse");
        assert_eq!(parsed.amount, 0.5);
        assert_eq!(
            static_command_title(".5 m"),
            Some("0.5 米 = 50 厘米 = 500 毫米 = 19.685 英寸".to_string())
        );
    }

    #[test]
    fn allows_js_whitespace_between_amount_and_unit_and_at_edges() {
        // \s 含换行/全角空格/不间断空格（JS 集合）。
        assert!(parse_conversion_query("1\nm").is_some());
        assert!(parse_conversion_query("\u{3000}2 kg\u{00A0}").is_some());
        // 制表符分隔同样命中。
        assert!(parse_conversion_query("3\tcm").is_some());
    }

    #[test]
    fn rejects_partial_matches_and_malformed_amounts() {
        // 正则锚定 ^...$：尾部残留即整体失败（不回退成部分匹配）。
        for query in [
            "1 m x",
            "1 m 2",
            "1 cm extra",
            "1.",
            "1.cm",
            "1.5.6",
            "12abc",
            "1m米",
            "-1 m",
        ] {
            assert_eq!(
                parse_conversion_query(query),
                None,
                "expected None for {query:?}"
            );
        }
    }

    // ---- 体积算式切分细节 ----

    #[test]
    fn volume_expression_requires_exactly_three_dimensions() {
        // 少于/多于 3 维 → None。
        assert_eq!(create_static_conversion_command("1cm x 2cm"), None);
        assert_eq!(
            create_static_conversion_command("1cm x 2cm x 3cm x 4cm"),
            None
        );
        // 空维度（首尾/连续分隔符产生空片段）→ 维度解析失败 → None。
        assert_eq!(create_static_conversion_command("x 1cm x 2cm x 3cm"), None);
        assert_eq!(create_static_conversion_command("1cm x 2cm x 3cm x"), None);
        assert_eq!(create_static_conversion_command("1cm x x 2cm x 3cm"), None);
        // 非长度维度（kg）→ None。
        assert_eq!(create_static_conversion_command("1cm x 2cm x 1kg"), None);
        // 空串/纯空白 → None。
        assert_eq!(create_static_conversion_command(""), None);
    }

    #[test]
    fn volume_expression_separator_is_case_insensitive() {
        assert_eq!(
            static_command_title("2cm X 3cm x 1cm"),
            static_command_title("2cm x 3cm x 1cm")
        );
    }

    #[test]
    fn kind_and_unit_literals_round_trip() {
        for kind in [
            ParsedConversionKind::Length,
            ParsedConversionKind::Weight,
            ParsedConversionKind::Currency,
            ParsedConversionKind::Volume,
        ] {
            assert_eq!(kind.as_str(), format!("{kind:?}").to_lowercase());
        }

        for unit in [
            ParsedConversionUnit::Centimeter,
            ParsedConversionUnit::Inch,
            ParsedConversionUnit::Millimeter,
            ParsedConversionUnit::Meter,
            ParsedConversionUnit::Kilogram,
            ParsedConversionUnit::Gram,
            ParsedConversionUnit::Pound,
            ParsedConversionUnit::Liter,
            ParsedConversionUnit::Milliliter,
            ParsedConversionUnit::CubicMeter,
            ParsedConversionUnit::CubicCentimeter,
            ParsedConversionUnit::CubicInch,
            ParsedConversionUnit::Usd,
        ] {
            match unit {
                ParsedConversionUnit::CubicMeter
                | ParsedConversionUnit::CubicCentimeter
                | ParsedConversionUnit::CubicInch => {}
                _ => assert_eq!(unit.as_str(), format!("{unit:?}").to_lowercase()),
            }
        }
        assert_eq!(ParsedConversionUnit::CubicMeter.as_str(), "cubicMeter");
        assert_eq!(
            ParsedConversionUnit::CubicCentimeter.as_str(),
            "cubicCentimeter"
        );
        assert_eq!(ParsedConversionUnit::CubicInch.as_str(), "cubicInch");
        assert_eq!(ExchangeRateResultSource::Live.as_str(), "live");
        assert_eq!(ExchangeRateResultSource::Cache.as_str(), "cache");
    }

    #[test]
    fn volume_expression_parse_exposes_dimensions() {
        let parsed =
            parse_volume_calculation("1m × 20cm × 30mm").expect("volume expression should parse");
        assert_eq!(
            parsed.dimensions,
            [
                ParsedVolumeDimension {
                    amount: 1.0,
                    unit: ParsedConversionUnit::Meter
                },
                ParsedVolumeDimension {
                    amount: 20.0,
                    unit: ParsedConversionUnit::Centimeter
                },
                ParsedVolumeDimension {
                    amount: 30.0,
                    unit: ParsedConversionUnit::Millimeter
                },
            ]
        );
        assert_eq!(parse_volume_calculation("1m x 20cm"), None);
    }

    // ---- ECMA-262 数值输出（复用 calculator 移植的补充锁定） ----

    #[test]
    fn formats_huge_and_tiny_results_like_js_tostring() {
        // 整数位 > 21 → 指数形式；小数位过深 → 前导零或指数形式。
        assert_eq!(
            static_command_title("1000000000000000000000 m3"),
            Some(
                "1e+21 立方米 = 1e+24 升 = 1e+27 毫升 = 1e+27 立方厘米 = 6.10237e+25 立方英寸"
                    .to_string()
            )
        );
        assert_eq!(
            static_command_title("0.000001 m"),
            Some("0.000001 米 = 0.0001 厘米 = 0.001 毫米 = 0.0000393701 英寸".to_string())
        );
    }

    // ---- Task 6：动态货币路径（quickConverter.test.ts 货币用例全量移植） ----

    fn live_rate(rate: f64) -> ExchangeRateResult {
        ExchangeRateResult {
            fetched_at: "2026-05-18T00:00:00.000Z".to_string(),
            provider: "Frankfurter".to_string(),
            rate,
            source: ExchangeRateResultSource::Live,
            updated_at: "2026-05-18".to_string(),
        }
    }

    fn cached_rate(rate: f64, updated_at: &str) -> ExchangeRateResult {
        ExchangeRateResult {
            fetched_at: "2026-05-18T00:00:00.000Z".to_string(),
            provider: "Frankfurter".to_string(),
            rate,
            source: ExchangeRateResultSource::Cache,
            updated_at: updated_at.to_string(),
        }
    }

    #[test]
    fn creates_a_live_usd_to_cny_command() {
        // TS：'1美元' + live 7.1234 → title '1 美元 ≈ 7.12 人民币'。
        let command = create_quick_converter_command("1美元", Some(&live_rate(7.1234)))
            .expect("command for currency query with live rate");

        assert_eq!(command.title, "1 美元 ≈ 7.12 人民币");
        assert_eq!(
            command.subtitle.as_deref(),
            Some("实时汇率 · 更新时间 2026-05-18")
        );
        assert_eq!(command.action.action_type, CommandActionType::CopyText);
        assert_eq!(
            command
                .action
                .payload
                .get("text")
                .and_then(|value| value.as_str()),
            Some("1 美元 ≈ 7.12 人民币")
        );
    }

    #[test]
    fn uses_cached_usd_to_cny_fallback() {
        // TS：'2 USD' + cache 7.1 → '2 美元 ≈ 14.20 人民币'（toFixed(2) 尾零）。
        let command =
            create_quick_converter_command("2 USD", Some(&cached_rate(7.1, "2026-05-17")))
                .expect("command for currency query with cached rate");

        assert_eq!(command.title, "2 美元 ≈ 14.20 人民币");
        assert_eq!(
            command.subtitle.as_deref(),
            Some("缓存汇率 · 更新时间 2026-05-17")
        );
    }

    #[test]
    fn returns_no_command_when_currency_rate_is_unavailable() {
        assert_eq!(create_quick_converter_command("1美元", None), None);
    }

    #[test]
    fn rejects_non_positive_exchange_rates() {
        // TS：rate: 0 → undefined；负值同判（rate.rate <= 0）。
        assert_eq!(
            create_quick_converter_command("1美元", Some(&live_rate(0.0))),
            None
        );
        assert_eq!(
            create_quick_converter_command("1美元", Some(&live_rate(-7.1))),
            None
        );
    }

    #[test]
    fn rejects_non_finite_exchange_rates() {
        assert_eq!(
            create_quick_converter_command("1美元", Some(&live_rate(f64::NAN))),
            None
        );
        assert_eq!(
            create_quick_converter_command("1美元", Some(&live_rate(f64::INFINITY))),
            None
        );
    }

    #[test]
    fn non_currency_queries_ignore_the_rate_and_keep_static_output() {
        let command = create_quick_converter_command("1厘米", Some(&live_rate(7.1234)))
            .expect("static command takes precedence");
        assert_eq!(command.subtitle, None);
        assert_eq!(command.title, "1 厘米 = 10 毫米 = 0.01 米 = 0.393701 英寸");
    }

    #[test]
    fn rejects_currency_conversion_whose_product_overflows() {
        // amount 1e307（有限）× rate 1e308 → inf → None。
        let query = format!("{}{}美元", "1", "0".repeat(307));
        let parsed = parse_conversion_query(&query).expect("amount itself stays finite");
        assert_eq!(parsed.kind, ParsedConversionKind::Currency);
        assert_eq!(
            create_quick_converter_command(&query, Some(&live_rate(1e308))),
            None
        );
    }

    // ---- convert_currency 判别 ----

    #[test]
    fn convert_currency_rejects_unsupported_pairs() {
        let rate = live_rate(7.1);
        for (from, to) in [
            ("CNY", "USD"),
            ("USD", "USD"),
            ("EUR", "CNY"),
            ("USD", "JPY"),
            ("", "CNY"),
            ("USD", ""),
        ] {
            assert_eq!(
                convert_currency(1.0, from, to, Some(&rate)),
                Err(ConvertCurrencyError::UnsupportedPair),
                "unexpected result for {from}->{to}"
            );
        }
        // 大小写不敏感（对齐单位别名 toLowerCase 归一）。
        assert_eq!(convert_currency(1.0, "usd", "cny", Some(&rate)), Ok(7.1));
        assert_eq!(convert_currency(1.0, "Usd", "CNY", Some(&rate)), Ok(7.1));
    }

    #[test]
    fn convert_currency_error_precedence_matches_ts_checks() {
        assert_eq!(
            convert_currency(1.0, "USD", "CNY", None),
            Err(ConvertCurrencyError::RateUnavailable)
        );
        assert_eq!(
            convert_currency(1.0, "USD", "CNY", Some(&live_rate(0.0))),
            Err(ConvertCurrencyError::InvalidRate)
        );
        assert_eq!(
            convert_currency(1.0, "USD", "CNY", Some(&live_rate(-1.0))),
            Err(ConvertCurrencyError::InvalidRate)
        );
        assert_eq!(
            convert_currency(1.0, "USD", "CNY", Some(&live_rate(f64::NAN))),
            Err(ConvertCurrencyError::InvalidRate)
        );
        assert_eq!(
            convert_currency(1e308, "USD", "CNY", Some(&live_rate(10.0))),
            Err(ConvertCurrencyError::ConversionNotFinite)
        );
        assert_eq!(
            convert_currency(2.0, "USD", "CNY", Some(&live_rate(7.1))),
            Ok(14.2)
        );
        // 0 金额 × 正汇率 = 0（有限）→ 合法。
        assert_eq!(
            convert_currency(0.0, "USD", "CNY", Some(&live_rate(7.1))),
            Ok(0.0)
        );
    }

    // ---- format_currency：JS toFixed(2) 精确移植（期望值由 node 实测取得） ----

    #[test]
    fn format_currency_matches_js_tofixed_on_exact_ties() {
        // 精确平局（|x| = 奇/8）→ 取较大 n（Rust {:.2} 会舍到偶，必须特判）。
        let cases: &[(&str, f64, &str)] = &[
            ("0.125", 0.125, "0.13"),
            ("0.375", 0.375, "0.38"),
            ("1.125", 1.125, "1.13"),
            ("1.375", 1.375, "1.38"),
            ("2.875", 2.875, "2.88"),
            ("-0.125", -0.125, "-0.13"),
        ];
        for (name, value, expected) in cases {
            assert_eq!(
                format_currency(*value),
                Some((*expected).to_string()),
                "unexpected toFixed(2) for {name}"
            );
        }
    }

    #[test]
    fn format_currency_matches_js_tofixed_on_non_tie_values() {
        // 非平局：double 实际值偏离十进制半点，JS 与 Rust 精确舍入一致。
        let cases: &[(&str, f64, &str)] = &[
            ("0", 0.0, "0.00"),
            ("0.5", 0.5, "0.50"),
            ("2.5", 2.5, "2.50"),
            ("-2.5", -2.5, "-2.50"),
            ("0.005", 0.005, "0.01"),
            ("0.015", 0.015, "0.01"),
            ("0.045", 0.045, "0.04"),
            ("0.001", 0.001, "0.00"),
            ("8.235", 8.235, "8.23"),
            ("1.005", 1.005, "1.00"),
            ("1.006", 1.006, "1.01"),
            ("2.675", 2.675, "2.67"),
            ("7.005", 7.005, "7.00"),
            ("7.1234", 7.1234, "7.12"),
            ("14.2", 14.2, "14.20"),
            ("123.456789", 123.456789, "123.46"),
            ("1e-7", 1e-7, "0.00"),
            ("1e20", 1e20, "100000000000000000000.00"),
        ];
        for (name, value, expected) in cases {
            assert_eq!(
                format_currency(*value),
                Some((*expected).to_string()),
                "unexpected toFixed(2) for {name}"
            );
        }
    }

    #[test]
    fn format_currency_falls_back_to_tostring_above_1e21() {
        // |x| ≥ 1e21 → Number::toString(x)（指数形式，无 ".00" 尾巴）。
        assert_eq!(format_currency(1e21), Some("1e+21".to_string()));
        assert_eq!(format_currency(-1e21), Some("-1e+21".to_string()));
        assert_eq!(format_currency(1.5e21), Some(js_number_to_string(1.5e21)));
    }

    #[test]
    fn format_currency_rejects_non_finite_values() {
        assert_eq!(format_currency(f64::NAN), None);
        assert_eq!(format_currency(f64::INFINITY), None);
        assert_eq!(format_currency(f64::NEG_INFINITY), None);
        // -0.0 → "0.00"（JS (-0).toFixed(2) === "0.00"）。
        assert_eq!(format_currency(-0.0), Some("0.00".to_string()));
    }
}
