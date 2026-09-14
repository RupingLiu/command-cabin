//! 计算器内置功能。移植自
//! `packages/built-in-plugins/calculator/src/evaluateExpression.ts` 与
//! `packages/built-in-plugins/calculator/src/index.ts`。
//!
//! 语义保真要点：
//! - 数值全程 `f64`（JS number 即 IEEE-754 双精度）；
//! - 除零返回 `NaN`（对应 TS `applyBinaryOperator` 的 `right === 0 ? NaN` 分支，
//!   注意 `-0 === 0` 为真，因此除以 `-0` 同样得 `NaN`），随后被有限性检查
//!   折叠为 `None`（静默失败，与 TS 一致）；
//! - 解析成功的 `-0` 归一为 `0`（TS `Object.is(value, -0) ? 0 : value`）；
//! - `formatResult` 逐字对应 TS `Number(value.toPrecision(12)).toString()`：
//!   先按 12 位有效数字舍入（JS 规则：平局取较大者，即十进制"五入"），
//!   再按 ECMA-262 `Number::toString` 规则输出（整数最长 21 位十进制展开，
//!   指数形式阈值为 `n > 21` 或 `n <= -6`，正指数带 `+` 号）；
//! - 空白字符按 JS `/\s/` 的集合判断（含 `\u{FEFF}`，不含 `\u{85}`），
//!   与 Rust `char::is_whitespace` 的 Unicode White_Space 集合不同；
//! - 长度上限按 JS `string.length`（UTF-16 码元数）计。

use crate::command::types::{
    Command, CommandAction, CommandActionType, CommandPayload, CommandSource,
};

pub const CALCULATOR_RESULT_COMMAND_ID: &str = "calculator.result";
pub const CALCULATOR_PLUGIN_ID: &str = "calculator";

const MAX_EXPRESSION_LENGTH: usize = 4_096;
const MAX_NESTING_DEPTH: i32 = 100;
const MAX_UNARY_OPERATOR_CHAIN: i32 = 100;

/// 求值算术表达式；非法、超限或结果非有限值时返回 `None`（静默）。
pub fn evaluate_expression(expression: &str) -> Option<String> {
    if !is_expression_within_limits(expression) {
        return None;
    }

    // TS 侧以 try/catch 兜底；此处解析不 panic（深度受上限约束），无需等价物。
    let value = ExpressionParser::new(expression).parse();
    value.map(format_result)
}

/// 由查询串构造"复制计算结果"命令；表达式非法时返回 `None`。
///
/// subtitle 沿用 TS 硬编码英文（保持模块纯度、与 TS 逐字对齐）；
/// 若需要本地化，由接线方（查询管线/渲染层）在展示时处理。
pub fn create_calculator_result_command(query: &str) -> Option<Command> {
    let result = evaluate_expression(query)?;

    let mut payload = CommandPayload::new();
    payload.insert("text".into(), result.clone().into());

    Some(Command {
        id: CALCULATOR_RESULT_COMMAND_ID.to_string(),
        source: CommandSource::Plugin,
        title: result.clone(),
        subtitle: Some("Copy result to clipboard".to_string()),
        keywords: vec![
            "calculator".to_string(),
            "math".to_string(),
            query.to_string(),
            result,
        ],
        icon: None,
        plugin_id: Some(CALCULATOR_PLUGIN_ID.to_string()),
        action: CommandAction {
            action_type: CommandActionType::CopyText,
            payload,
        },
    })
}

struct ExpressionParser {
    input: Vec<char>,
    position: usize,
}

impl ExpressionParser {
    fn new(input: &str) -> Self {
        Self {
            input: input.chars().collect(),
            position: 0,
        }
    }

    fn parse(&mut self) -> Option<f64> {
        self.skip_whitespace();

        if self.position >= self.input.len() {
            return None;
        }

        let value = self.parse_expression();
        self.skip_whitespace();

        let value = value.filter(|value| self.position == self.input.len() && value.is_finite())?;

        // TS：Object.is(value, -0) ? 0 : value
        Some(if value == 0.0 && value.is_sign_negative() {
            0.0
        } else {
            value
        })
    }

    fn parse_expression(&mut self) -> Option<f64> {
        self.parse_binary_expression(Self::parse_term, &['+', '-'])
    }

    fn parse_term(&mut self) -> Option<f64> {
        self.parse_binary_expression(Self::parse_unary, &['*', '/'])
    }

    fn parse_binary_expression(
        &mut self,
        parse_operand: fn(&mut Self) -> Option<f64>,
        operators: &[char],
    ) -> Option<f64> {
        let mut value = parse_operand(self)?;

        loop {
            self.skip_whitespace();
            let Some(operator) = self
                .peek()
                .filter(|op| is_binary_operator(*op) && operators.contains(op))
            else {
                return Some(value);
            };

            self.position += 1;
            let right = parse_operand(self)?;

            value = apply_binary_operator(value, operator, right);

            if !value.is_finite() {
                return None;
            }
        }
    }

    fn parse_unary(&mut self) -> Option<f64> {
        self.skip_whitespace();

        if let Some(operator @ ('+' | '-')) = self.peek() {
            self.position += 1;
            let value = self.parse_unary()?;

            return Some(if operator == '-' { -value } else { value });
        }

        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Option<f64> {
        self.skip_whitespace();

        if self.peek() == Some('(') {
            self.position += 1;
            let value = self.parse_expression();
            self.skip_whitespace();

            let value = value.filter(|_| self.peek() == Some(')'))?;
            self.position += 1;
            return Some(value);
        }

        self.parse_number()
    }

    fn parse_number(&mut self) -> Option<f64> {
        let start = self.position;
        let mut digits_before_decimal = 0;
        let mut digits_after_decimal = 0;

        while self.peek().is_some_and(is_digit) {
            self.position += 1;
            digits_before_decimal += 1;
        }

        if self.peek() == Some('.') {
            self.position += 1;

            while self.peek().is_some_and(is_digit) {
                self.position += 1;
                digits_after_decimal += 1;
            }
        }

        if digits_before_decimal == 0 && digits_after_decimal == 0 {
            self.position = start;
            return None;
        }

        // TS：Number(this.input.slice(start, this.position))。切片仅含数字与
        // 至多一个小数点；JS Number("1.") === 1，Rust 解析对尾点同样兼容，
        // 此处显式去尾点以保证行为一致。
        let text: String = self.input[start..self.position].iter().collect();
        let text = text.strip_suffix('.').unwrap_or(&text);
        text.parse::<f64>().ok()
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(is_js_whitespace) {
            self.position += 1;
        }
    }

    fn peek(&self) -> Option<char> {
        self.input.get(self.position).copied()
    }
}

/// TS `isExpressionWithinLimits`：长度/嵌套深度/一元链三重上限。
fn is_expression_within_limits(expression: &str) -> bool {
    // TS expression.length 为 UTF-16 码元数。
    if expression.encode_utf16().count() > MAX_EXPRESSION_LENGTH {
        return false;
    }

    let mut depth: i32 = 0;
    let mut unary_operator_chain: i32 = 0;
    let mut expecting_operand = true;

    for character in expression.chars() {
        if is_js_whitespace(character) {
            continue;
        }

        if character == '(' {
            depth += 1;
            unary_operator_chain = 0;

            if depth > MAX_NESTING_DEPTH {
                return false;
            }

            expecting_operand = true;
            continue;
        }

        if character == ')' {
            depth -= 1;
            unary_operator_chain = 0;
            expecting_operand = false;
            continue;
        }

        if expecting_operand && (character == '+' || character == '-') {
            unary_operator_chain += 1;

            if unary_operator_chain > MAX_UNARY_OPERATOR_CHAIN {
                return false;
            }

            continue;
        }

        unary_operator_chain = 0;
        expecting_operand = is_binary_operator(character);
    }

    true
}

fn is_digit(value: char) -> bool {
    value.is_ascii_digit()
}

fn is_binary_operator(value: char) -> bool {
    matches!(value, '+' | '-' | '*' | '/')
}

/// JS 正则 `/\s/` 的空白集合（与 `char::is_whitespace` 不同：多 `\u{FEFF}`、缺 `\u{85}`）。
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

/// TS `applyBinaryOperator`：除数为 `0`（含 `-0`）时返回 `NaN`，由上层有限性检查拒绝。
fn apply_binary_operator(left: f64, operator: char, right: f64) -> f64 {
    match operator {
        '+' => left + right,
        '-' => left - right,
        '*' => left * right,
        // `right == 0.0` 对 `-0.0` 同样为真（等价 JS `right === 0`）。
        '/' if right == 0.0 => f64::NAN,
        '/' => left / right,
        _ => unreachable!("operator is validated by is_binary_operator"),
    }
}

/// TS `formatResult`：`Number(value.toPrecision(12)).toString()`。
fn format_result(value: f64) -> String {
    let rounded = number_to_precision(value, 12);
    js_number_to_string(rounded)
}

/// 等价 JS `Number(value.toPrecision(precision))`：按 `precision` 位有效数字舍入后
/// 解析回最近 double。JS `toPrecision` 平局规则取较大 n（十进制"五入"），
/// 因此只需比较第 `precision + 1` 位数字是否 `>= '5'`。
///
/// `pub(crate)`：`features::quick_converter` 的 `formatSignificantDecimal`
/// （6 位有效数字）复用同一实现，避免重复移植舍入规则。
pub(crate) fn number_to_precision(value: f64, precision: usize) -> f64 {
    if value == 0.0 {
        // JS：(±0).toPrecision(12) === "0.00000000000" → Number → 0
        return 0.0;
    }

    // 以 30 位有效数字格式化（Rust 按 double 的精确十进制展开正确舍入），
    // 超出精确展开的位数补零，因此前 14 位必然精确，足以判定进位。
    let sign: f64 = if value < 0.0 { -1.0 } else { 1.0 };
    let scientific = format!("{:.*e}", precision + 18, value.abs());
    let Some((mantissa, exponent)) = scientific.split_once('e') else {
        return value;
    };
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let Ok(exponent) = exponent.parse::<i32>() else {
        return value;
    };

    let mut kept: Vec<u8> = digits.as_bytes()[..precision].to_vec();
    let mut exponent = exponent;
    if digits.as_bytes()[precision] >= b'5' {
        let mut index = kept.len();
        loop {
            if index == 0 {
                // 全 9 进位：999... → 100...（有效位回到 precision 位，指数 +1）
                kept = vec![b'1'];
                kept.resize(precision, b'0');
                exponent += 1;
                break;
            }
            index -= 1;
            if kept[index] == b'9' {
                kept[index] = b'0';
            } else {
                kept[index] += 1;
                break;
            }
        }
    }

    let rounded = format!(
        "{}.{}e{}",
        kept[0] as char,
        std::str::from_utf8(&kept[1..]).unwrap_or_default(),
        exponent
    );
    rounded
        .parse::<f64>()
        .map(|rounded| sign * rounded)
        .unwrap_or(value)
}

/// 等价 JS `Number.prototype.toString()`（ECMA-262 Number::toString（x））：
/// 十进制展开的整数位数为 `n`、数字个数为 `k` 时——
/// `k <= n <= 21`：数字后补 `n - k` 个零；`0 < n <= 21`：在第 `n` 位后插小数点；
/// `-6 < n <= 0`：`0.` + `|n|` 个零 + 数字；否则指数形式（`e+`/`e-`）。
///
/// `pub(crate)`：`features::quick_converter` 的 `formatConciseDecimal` /
/// `formatSignificantDecimal` 复用同一实现，避免重复移植。
pub(crate) fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value < 0.0 {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        };
    }
    if value == 0.0 {
        // JS：(-0).toString() === "0"（parse 层已把 -0 归一为 0，此处兜底一致）。
        return "0".to_string();
    }

    let sign = if value < 0.0 { "-" } else { "" };
    let magnitude = value.abs();

    // Rust 的 `{:e}` 输出最短往返表示，形如 "d[.ddd]e<exp>"，与 JS 的最短
    // 数字串一致；据此取数字串与十进制指数。
    let scientific = format!("{magnitude:e}");
    let Some((mantissa, exponent)) = scientific.split_once('e') else {
        return scientific;
    };
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let Ok(exponent) = exponent.parse::<i32>() else {
        return scientific;
    };

    let digit_count = digits.len() as i32;
    let integer_digits = exponent + 1; // ECMA 记号中的 n

    let mut out = String::from(sign);
    if digit_count <= integer_digits && integer_digits <= 21 {
        out.push_str(&digits);
        for _ in 0..(integer_digits - digit_count) {
            out.push('0');
        }
    } else if 0 < integer_digits && integer_digits <= 21 {
        let split = integer_digits as usize;
        out.push_str(&digits[..split]);
        out.push('.');
        out.push_str(&digits[split..]);
    } else if -6 < integer_digits && integer_digits <= 0 {
        out.push_str("0.");
        for _ in 0..(-integer_digits) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if digit_count > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let printed_exponent = integer_digits - 1;
        out.push('e');
        if printed_exponent >= 0 {
            out.push('+');
        } else {
            out.push('-');
        }
        out.push_str(&printed_exponent.unsigned_abs().to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::types::CommandActionType;

    #[test]
    fn evaluates_basic_arithmetic() {
        assert_eq!(evaluate_expression("1 + 2"), Some("3".to_string()));
        assert_eq!(evaluate_expression("2 * (3 + 4)"), Some("14".to_string()));
        assert_eq!(evaluate_expression(" 10 / 4 "), Some("2.5".to_string()));
        assert_eq!(evaluate_expression(".5 + 1.25"), Some("1.75".to_string()));
        assert_eq!(
            evaluate_expression("-(2 + 3) * +4"),
            Some("-20".to_string())
        );
    }

    #[test]
    fn evaluates_precedence_and_unary_chains() {
        assert_eq!(
            evaluate_expression("1 + 2 * 3 - 4 / 8"),
            Some("6.5".to_string())
        );
        assert_eq!(evaluate_expression("- - - 3"), Some("-3".to_string()));
        assert_eq!(evaluate_expression("1 + + 2"), Some("3".to_string()));
        assert_eq!(evaluate_expression("+ 5"), Some("5".to_string()));
        assert_eq!(
            evaluate_expression("((1 + 2)) * (3)"),
            Some("9".to_string())
        );
    }

    #[test]
    fn rejects_invalid_expressions() {
        for expression in [
            "", "   ", "1 +", "2 ** 3", "abc", "1 / 0", "(1 + 2", "1 2", "1e3", "1 + 2)", ")1(",
            "1..2", "1.2.3", "0 / 0",
        ] {
            assert_eq!(
                evaluate_expression(expression),
                None,
                "expected None for {expression:?}"
            );
        }
    }

    #[test]
    fn overflow_yields_none() {
        // 400 位 9 → Infinity → 静默 None
        let expression = "9".repeat(400);
        assert_eq!(evaluate_expression(&expression), None);
    }

    #[test]
    fn rejects_expressions_with_excessive_nesting_without_throwing() {
        let expression = format!("{}1{}", "(".repeat(200), ")".repeat(200));

        assert_eq!(evaluate_expression(&expression), None);
        assert_eq!(create_calculator_result_command(&expression), None);
    }

    #[test]
    fn rejects_expressions_with_excessive_unary_operators_without_throwing() {
        let expression = format!("{}1", "+".repeat(200));

        assert_eq!(evaluate_expression(&expression), None);
        assert_eq!(create_calculator_result_command(&expression), None);
    }

    #[test]
    fn nesting_and_unary_limits_allow_exact_boundaries() {
        // 深度恰为 100 / 一元链恰为 100 时仍然合法（上限判断为 `>`）。
        let nested = format!("{}1{}", "(".repeat(100), ")".repeat(100));
        assert_eq!(evaluate_expression(&nested), Some("1".to_string()));

        let unary = format!("{}1", "+".repeat(100));
        assert_eq!(evaluate_expression(&unary), Some("1".to_string()));
    }

    #[test]
    fn length_limit_uses_utf16_code_units_with_exact_boundary() {
        // 4096 个空白 + "1 + 2"（长度恰为 4096）→ 合法。
        let within = format!("{}1 + 2", " ".repeat(MAX_EXPRESSION_LENGTH - 5));
        assert_eq!(evaluate_expression(&within), Some("3".to_string()));

        // 4097 → 拒绝。
        let beyond = format!("{}1 + 2", " ".repeat(MAX_EXPRESSION_LENGTH - 4));
        assert_eq!(evaluate_expression(&beyond), None);
    }

    #[test]
    fn formats_results_with_twelve_significant_digits() {
        // toPrecision(12) 抹平浮点噪声。
        assert_eq!(evaluate_expression("0.1 + 0.2"), Some("0.3".to_string()));
        assert_eq!(
            evaluate_expression("1 / 3"),
            Some("0.333333333333".to_string())
        );
        assert_eq!(
            evaluate_expression("2 / 3"),
            Some("0.666666666667".to_string())
        );
        assert_eq!(
            evaluate_expression("10 / 3"),
            Some("3.33333333333".to_string())
        );
        assert_eq!(evaluate_expression("0.3 - 0.1"), Some("0.2".to_string()));
        assert_eq!(evaluate_expression("0.1 * 3"), Some("0.3".to_string()));
        assert_eq!(
            evaluate_expression("3.14159265358979 * 1"),
            Some("3.14159265359".to_string())
        );
    }

    #[test]
    fn formats_integer_results_without_decimal_noise() {
        assert_eq!(
            evaluate_expression("12345678901234 / 10"),
            Some("1234567890120".to_string())
        );
        assert_eq!(evaluate_expression("000123"), Some("123".to_string()));
        assert_eq!(evaluate_expression("007 + 1"), Some("8".to_string()));
        assert_eq!(evaluate_expression("2 * 3."), Some("6".to_string()));
        assert_eq!(evaluate_expression("1. * 2"), Some("2".to_string()));
    }

    #[test]
    fn formats_scientific_notation_beyond_thresholds() {
        // 整数位 > 21 → 指数形式（正指数带 + 号）。
        assert_eq!(
            evaluate_expression("1000000000000000000000"),
            Some("1e+21".to_string())
        );
        assert_eq!(
            evaluate_expression("999999999999999999999"),
            Some("1e+21".to_string())
        );
        assert_eq!(
            evaluate_expression("12345678901234567890 * 1000"),
            Some("1.23456789012e+22".to_string())
        );
        assert_eq!(
            evaluate_expression("999999999999 * 999999999999"),
            Some("9.99999999998e+23".to_string())
        );
        assert_eq!(
            evaluate_expression("99999999999999999999999 * 99999999999999999999999"),
            Some("1e+46".to_string())
        );
        // 小数位 <= -7（n <= -6）→ 指数形式（负指数无 + 号）。
        assert_eq!(evaluate_expression("0.0000001"), Some("1e-7".to_string()));
        assert_eq!(
            evaluate_expression("0.000000000001"),
            Some("1e-12".to_string())
        );
        assert_eq!(
            evaluate_expression("1 / 999999999999"),
            Some("1e-12".to_string())
        );
        // 边界内保持普通形式：1e-6 → "0.000001"。
        assert_eq!(
            evaluate_expression("0.000001"),
            Some("0.000001".to_string())
        );
        // 恰 21 位整数 → 普通形式。
        assert_eq!(
            evaluate_expression("123456789012345678901"),
            Some("123456789012000000000".to_string())
        );
    }

    #[test]
    fn rounds_half_up_at_precision_boundary() {
        // 123456789012.5 精确可表示（dyadic），toPrecision(12) 平局取较大者。
        assert_eq!(
            evaluate_expression("123456789012.5"),
            Some("123456789013".to_string())
        );
        // 12 位全 9 进位溢出到指数。
        assert_eq!(
            evaluate_expression(&format!("{}.{}", "9".repeat(30), "9".repeat(30))),
            Some("1e+30".to_string())
        );
    }

    #[test]
    fn normalizes_negative_zero_to_zero() {
        assert_eq!(evaluate_expression("-0"), Some("0".to_string()));
        assert_eq!(evaluate_expression("- 0"), Some("0".to_string()));
        assert_eq!(evaluate_expression("-(0)"), Some("0".to_string()));
        assert_eq!(evaluate_expression("0 * -1"), Some("0".to_string()));
    }

    #[test]
    fn preserves_sign_of_negative_results() {
        assert_eq!(evaluate_expression("1 - 2"), Some("-1".to_string()));
        assert_eq!(
            evaluate_expression("1.0000000000005"),
            Some("1".to_string())
        );
        assert_eq!(evaluate_expression("0.5 / 5"), Some("0.1".to_string()));
    }

    #[test]
    fn formats_subnormal_results_like_js_tostring() {
        // 5e-324（最小 subnormal）的最短往返字符串。
        let subnormal = format!("0.{}5", "0".repeat(323));
        assert_eq!(evaluate_expression(&subnormal), Some("5e-324".to_string()));
    }

    #[test]
    fn creates_copy_text_command_for_valid_calculator_input() {
        let command = create_calculator_result_command("1 + 2").expect("command");

        assert_eq!(command.id, "calculator.result");
        assert_eq!(command.source, CommandSource::Plugin);
        assert_eq!(command.title, "3");
        assert_eq!(
            command.subtitle.as_deref(),
            Some("Copy result to clipboard")
        );
        assert_eq!(
            command.keywords,
            vec![
                "calculator".to_string(),
                "math".to_string(),
                "1 + 2".to_string(),
                "3".to_string(),
            ]
        );
        assert_eq!(command.plugin_id.as_deref(), Some("calculator"));
        assert_eq!(command.action.action_type, CommandActionType::CopyText);
        assert_eq!(
            command.action.payload.get("text").and_then(|v| v.as_str()),
            Some("3")
        );
    }

    #[test]
    fn does_not_create_command_for_invalid_calculator_input() {
        assert_eq!(create_calculator_result_command("1 +"), None);
    }

    #[test]
    fn js_number_to_string_matches_reference_cases() {
        assert_eq!(js_number_to_string(100.0), "100");
        assert_eq!(js_number_to_string(123.456), "123.456");
        assert_eq!(js_number_to_string(0.0001), "0.0001");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(1e20), "100000000000000000000");
        assert_eq!(js_number_to_string(1e-7), "1e-7");
        assert_eq!(js_number_to_string(1e-6), "0.000001");
        assert_eq!(js_number_to_string(1.5e21), "1.5e+21");
        assert_eq!(js_number_to_string(-2.5), "-2.5");
        assert_eq!(js_number_to_string(-0.0), "0");
    }
}
