//! Server validation shared by the build script and runtime server picker.

use url::{Host, Url};

/// A server choice is an origin, never a URLPattern supplied by the page.
pub fn normalize_server(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url).map_err(|err| format!("Not a valid URL: {err}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The server URL must use http or https.".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("The server URL must not contain credentials.".into());
    }
    let host = parsed.host().ok_or("The server URL must have a host.")?;
    if let Host::Domain(host) = host {
        if !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        {
            return Err("The server host must not contain URL patterns.".into());
        }
    }
    let loopback = match host {
        Host::Domain(host) => host == "localhost",
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    };
    if parsed.scheme() == "http" && !loopback {
        return Err("Non-loopback servers must use https for native IPC.".into());
    }
    Ok(parsed.origin().ascii_serialization())
}

/// Unlike picker input, build defaults must already be origins. A trailing
/// slash is harmless, but a path, query or fragment is almost certainly a typo.
pub fn normalize_default_server(url: &str) -> Result<String, String> {
    let origin = normalize_server(url)?;
    let parsed = Url::parse(url).map_err(|err| err.to_string())?;
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(
            "The build-time server URL must be an origin with no path, query or fragment.".into(),
        );
    }
    Ok(origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_server_is_validated_and_normalized() {
        assert_eq!(
            normalize_default_server("https://ASSISTANT.example:443/").unwrap(),
            "https://assistant.example"
        );
        assert_eq!(
            normalize_default_server("http://localhost:8787/").unwrap(),
            "http://localhost:8787"
        );
        for url in [
            "assistant.example",
            "https://assistant.example/app",
            "https://assistant.example/?q=1",
            "https://assistant.example/#app",
        ] {
            assert!(normalize_default_server(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn http_is_only_for_explicit_loopback_choices() {
        for url in [
            "http://localhost:8787",
            "http://127.0.0.1:3000",
            "http://[::1]:5173",
        ] {
            assert!(normalize_server(url).is_ok(), "rejected {url}");
        }
        for url in [
            "http://assistant.example",
            "http://192.0.2.1",
            "http://localhost.evil.example",
        ] {
            assert!(normalize_server(url).is_err(), "accepted {url}");
        }
    }
}
