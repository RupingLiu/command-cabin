//! 共享的 ISO 8601 时间戳形态校验（crate 内部）。
//!
//! 从 favorites.rs 提取，供 favorites / history 两个仓储复用。与 `iso_now`
//! （migrations.rs）配套：`iso_now` 生成规范 UTC ISO，本校验接受
//! ISO 8601 形态字符串并原样保留（偏差约定见各仓储模块文档）。

/// 严格 ISO 8601 时间戳校验：`YYYY-MM-DDTHH:MM:SS(.f+)?(Z|±HH:MM)`，含闰年与范围检查。
pub(crate) fn is_iso8601_timestamp(value: &str) -> bool {
    fn digits(bytes: &[u8], from: usize, to: usize) -> Option<u32> {
        if bytes.len() < to {
            return None;
        }
        let mut value = 0u32;
        for &b in &bytes[from..to] {
            if !b.is_ascii_digit() {
                return None;
            }
            value = value * 10 + u32::from(b - b'0');
        }
        Some(value)
    }

    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    let (Some(year), Some(month), Some(day)) = (
        digits(bytes, 0, 4),
        digits(bytes, 5, 7),
        digits(bytes, 8, 10),
    ) else {
        return false;
    };
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return false;
    }
    if !(1..=12).contains(&month) {
        return false;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        _ => 28,
    };
    if !(1..=days_in_month).contains(&day) {
        return false;
    }
    let (Some(hour), Some(minute), Some(second)) = (
        digits(bytes, 11, 13),
        digits(bytes, 14, 16),
        digits(bytes, 17, 19),
    ) else {
        return false;
    };
    if bytes[13] != b':' || bytes[16] != b':' {
        return false;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }

    let mut index = 19;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == fraction_start {
            return false;
        }
    }

    match bytes.get(index) {
        Some(b'Z') => index + 1 == bytes.len(),
        Some(b'+') | Some(b'-') => {
            if bytes.len() != index + 6 {
                return false;
            }
            let (Some(offset_hour), Some(offset_minute)) = (
                digits(bytes, index + 1, index + 3),
                digits(bytes, index + 4, index + 6),
            ) else {
                return false;
            };
            bytes[index + 3] == b':' && offset_hour <= 23 && offset_minute <= 59
        }
        _ => false,
    }
}
