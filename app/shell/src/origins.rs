//! Process-local trust, shared by the navigation guard and Tauri's remote ACL.
//! Only startup configuration and the bootstrap server picker extend this set.

use std::collections::BTreeSet;

use tauri::utils::acl::RemoteUrlPattern;
use tauri::Url;

use crate::server_url::normalize_server;

#[derive(Clone)]
pub struct TrustedOrigins {
    origins: BTreeSet<String>,
    urls: Vec<String>,
    patterns: Vec<RemoteUrlPattern>,
}

impl TrustedOrigins {
    pub fn new() -> Self {
        Self {
            origins: BTreeSet::new(),
            urls: Vec::new(),
            patterns: Vec::new(),
        }
    }

    /// Returns false for a repeated choice. Previously chosen origins remain
    /// trusted until restart because Tauri's runtime ACL is append-only.
    pub fn add_server(&mut self, url: &str) -> Result<bool, String> {
        let origin = normalize_server(url)?;
        if self.origins.contains(&origin) {
            return Ok(false);
        }
        let parsed = Url::parse(&origin).map_err(|err| err.to_string())?;
        let port = parsed
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default();
        // IPv6 colons must be literal URLPattern characters, not parameter names.
        let host = parsed
            .host_str()
            .expect("validated server host")
            .replace(':', "\\:");
        let mut urls = vec![format!("{}://{host}{port}/*", parsed.scheme())];
        if let Some(url::Host::Domain(host)) = parsed.host() {
            // Loopback has no PR-preview domain. IP addresses have none either.
            if host != "localhost" {
                urls.push(format!(
                    "{}://pr-([a-z0-9-]+).{host}{port}/*",
                    parsed.scheme()
                ));
            }
        }
        let patterns = urls
            .iter()
            .map(|url| {
                url.parse::<RemoteUrlPattern>()
                    .map_err(|err| err.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.origins.insert(origin);
        self.urls.extend(urls);
        self.patterns.extend(patterns);
        Ok(true)
    }

    pub fn urls(&self) -> &[String] {
        &self.urls
    }

    pub fn is_allowed(&self, url: &Url) -> bool {
        self.patterns.iter().any(|pattern| pattern.test(url))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_choices_to_origins() {
        assert_eq!(
            normalize_server("https://ASSISTANT.example:443/path?q=1#part").unwrap(),
            "https://assistant.example"
        );
        assert_eq!(
            normalize_server("http://localhost:8787/a").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_server("https://bücher.example/").unwrap(),
            "https://xn--bcher-kva.example"
        );
    }

    #[test]
    fn rejects_schemes_credentials_and_patterns() {
        for candidate in [
            "file:///tmp/app",
            "tauri://localhost",
            "javascript:alert(1)",
            "https://user:password@assistant.example",
            "https://*.example",
            "https://%2a.example",
            "https://(host).example",
            "https://{host}.example",
            "https://host+.example",
        ] {
            assert!(normalize_server(candidate).is_err(), "accepted {candidate}");
        }
    }

    #[test]
    fn navigation_uses_the_ipc_patterns() {
        let mut trust = TrustedOrigins::new();
        trust
            .add_server("https://assistant.example:8443/path")
            .unwrap();
        assert_eq!(
            trust.urls(),
            [
                "https://assistant.example:8443/*",
                "https://pr-([a-z0-9-]+).assistant.example:8443/*"
            ]
        );
        for url in [
            "https://assistant.example:8443/app?q=1#fragment",
            "https://pr-12.assistant.example:8443/",
            "https://pr-123.assistant.example:8443/",
        ] {
            assert!(trust.is_allowed(&Url::parse(url).unwrap()), "refused {url}");
        }
        for url in [
            "http://localhost:8787/",
            "https://127.0.0.1/",
            "https://pr-1.evil.assistant.example:8443/",
            "https://pr-.assistant.example:8443/",
            "http://assistant.example:8443/",
            "https://assistant.example/",
            "https://other.assistant.example:8443/",
            "https://assistant.example.evil:8443/",
            "https://pr-123.other.example:8443/",
            "file:///tmp/app",
        ] {
            assert!(
                !trust.is_allowed(&Url::parse(url).unwrap()),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn only_explicit_choices_extend_trust_until_restart() {
        let mut trust = TrustedOrigins::new();
        assert!(trust.add_server("https://first.example").unwrap());
        let before = trust.urls().len();
        assert!(!trust.add_server("https://FIRST.example/path").unwrap());
        assert_eq!(trust.urls().len(), before);
        assert!(!trust.is_allowed(&Url::parse("https://second.example/").unwrap()));
        trust.add_server("https://second.example").unwrap();
        assert!(trust.is_allowed(&Url::parse("https://first.example/").unwrap()));
        assert!(trust.is_allowed(&Url::parse("https://second.example/").unwrap()));
        let mut restarted = TrustedOrigins::new();
        restarted.add_server("https://second.example").unwrap();
        assert!(!restarted.is_allowed(&Url::parse("https://first.example/").unwrap()));
    }

    #[test]
    fn loopback_ports_require_explicit_choices() {
        let mut trust = TrustedOrigins::new();
        assert!(trust.urls().is_empty());
        assert!(!trust.is_allowed(&Url::parse("http://localhost:8787/").unwrap()));
        trust.add_server("http://localhost:8787").unwrap();
        assert!(trust.is_allowed(&Url::parse("http://localhost:8787/").unwrap()));
        for url in [
            "http://localhost:3000/",
            "https://localhost:8787/",
            "http://127.0.0.1:8787/",
        ] {
            assert!(
                !trust.is_allowed(&Url::parse(url).unwrap()),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn rejected_choices_leave_trust_unchanged() {
        let mut trust = TrustedOrigins::new();
        trust.add_server("https://assistant.example").unwrap();
        let before = trust.urls().to_vec();
        assert!(trust.add_server("https://*.evil.example").is_err());
        assert_eq!(trust.urls(), before);
    }

    #[test]
    fn ip_and_localhost_servers_have_no_preview_patterns() {
        for server in [
            "http://localhost:8787",
            "http://127.0.0.1:8787",
            "https://192.0.2.1",
            "http://[::1]:8787",
        ] {
            let mut trust = TrustedOrigins::new();
            trust.add_server(server).unwrap();
            assert_eq!(trust.urls().len(), 1);
            assert!(
                trust.is_allowed(&Url::parse(server).unwrap()),
                "refused {server}"
            );
            if server.contains("[::1]") {
                assert!(!trust.is_allowed(&Url::parse("http://[::2]:8787/").unwrap()));
                assert!(!trust.is_allowed(&Url::parse("http://[::1]:8788/").unwrap()));
            }
        }
    }
}
