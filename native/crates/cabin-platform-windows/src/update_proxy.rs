//! Proxy selection for HTTPS update traffic. Explorer-launched apps usually have
//! no proxy environment variables, so also honor Windows' explicit user proxy.
//! PAC scripts are not evaluated here.
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

const INTERNET_SETTINGS: PCWSTR =
    w!("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");

pub(crate) fn for_url(url: &str) -> Option<ureq::Proxy> {
    let host = url
        .strip_prefix("https://")?
        .split('/')
        .next()?
        .split(':')
        .next()?;
    let bypass = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    if bypasses(host, &bypass) {
        return None;
    }
    for name in [
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        if let Ok(value) = std::env::var(name) {
            if let Ok(proxy) = ureq::Proxy::new(&value) {
                return Some(proxy);
            }
        }
    }
    system_proxy(host)
}

fn system_proxy(host: &str) -> Option<ureq::Proxy> {
    let mut enabled = 0u32;
    let mut size = 4;
    // SAFETY: the DWORD buffer and byte count are valid for the duration of call.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            INTERNET_SETTINGS,
            w!("ProxyEnable"),
            RRF_RT_REG_DWORD,
            None,
            Some((&mut enabled as *mut u32).cast()),
            Some(&mut size),
        )
    };
    if result.is_err()
        || enabled == 0
        || bypasses(host, &read_string("ProxyOverride").unwrap_or_default())
    {
        return None;
    }
    let server = https_server(&read_string("ProxyServer")?)?;
    ureq::Proxy::new(server).ok()
}

fn read_string(name: &str) -> Option<String> {
    let name = HSTRING::from(name);
    let mut size = 0;
    // SAFETY: first call queries size; the second fills an aligned UTF-16 buffer.
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            INTERNET_SETTINGS,
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
        .ok()
        .ok()?;
        if size == 0 || size > 32768 || !size.is_multiple_of(2) {
            return None;
        }
        let mut buffer = vec![0u16; size as usize / 2];
        RegGetValueW(
            HKEY_CURRENT_USER,
            INTERNET_SETTINGS,
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len());
        String::from_utf16(&buffer[..end]).ok()
    }
}

fn https_server(value: &str) -> Option<String> {
    let server = if value.contains('=') {
        value
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find(|(scheme, _)| scheme.trim().eq_ignore_ascii_case("https"))?
            .1
            .trim()
    } else {
        value.trim()
    };
    if server.is_empty() {
        return None;
    }
    Some(if server.contains("://") {
        server.to_string()
    } else {
        format!("http://{server}")
    })
}

fn bypasses(host: &str, list: &str) -> bool {
    let host = host.to_ascii_lowercase();
    list.split([';', ','])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|pattern| {
            let pattern = pattern.to_ascii_lowercase();
            let pattern = pattern.split(':').next().unwrap_or(&pattern);
            if pattern == "<local>" {
                return !host.contains('.');
            }
            if pattern.contains('*') {
                return wildcard_matches(&host, pattern);
            }
            let domain = pattern.trim_start_matches('.');
            host == domain || host.ends_with(&format!(".{domain}"))
        })
}

fn wildcard_matches(host: &str, pattern: &str) -> bool {
    let host = host.as_bytes();
    let mut matches = vec![false; host.len() + 1];
    matches[0] = true;
    for byte in pattern.bytes() {
        if byte == b'*' {
            for index in 1..=host.len() {
                matches[index] |= matches[index - 1];
            }
        } else {
            for index in (1..=host.len()).rev() {
                matches[index] = matches[index - 1] && host[index - 1] == byte;
            }
            matches[0] = false;
        }
    }
    matches[host.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_proxy_selects_https_mapping_and_uses_http_connect() {
        assert_eq!(
            https_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            https_server("http=other:80; https=localhost:7890; socks=localhost:9999").as_deref(),
            Some("http://localhost:7890")
        );
        assert_eq!(https_server("http=other:80"), None);
        assert_eq!(https_server(""), None);
    }
    #[test]
    fn proxy_bypass_respects_domains_wildcards_and_local_names() {
        assert!(bypasses("api.github.com", ".github.com"));
        assert!(!bypasses("notgithub.com", "github.com"));
        assert!(bypasses(
            "release-assets.githubusercontent.com",
            "*.githubusercontent.com"
        ));
        assert!(bypasses("localhost", "<local>;127.*"));
        assert!(!bypasses("github.com", "<local>;127.*"));
        assert!(bypasses("github.com", "*"));
        assert!(bypasses("api.github.com", "github.com:443"));
        assert!(bypasses("api.api.github.com", "*.api.*.com"));
    }
    #[test]
    fn local_http_tests_never_use_user_proxy() {
        assert!(for_url("http://127.0.0.1:12345/test").is_none());
    }
}
