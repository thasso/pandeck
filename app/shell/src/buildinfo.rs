//! Which build of the shell this is, for the page and for the About panel.
//!
//! An installed .app cannot ask afterwards, so `build.rs` stamps the git answers
//! in at compile time and this module reads them back. The shape mirrors
//! `BuildInfo` in `app/shared/buildInfo.ts` — the page consumes the shell's
//! answer and the server's through one type — and so do the display rules, so
//! the About panel and Settings → About never describe the same build
//! differently.
//!
//! The version is not stamped: `tauri.conf.json` declares it, `package_info()`
//! carries it, and `pnpm run version:set` owns every copy in the repository.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// How many hex characters of a sha identify a commit here. Matches
/// `SHORT_COMMIT_LENGTH` in `app/shared/buildInfo.ts`.
const SHORT_COMMIT_LENGTH: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    /// Full commit sha, absent when the build had no repository to ask.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    /// Whether this commit carries the `v<version>` release tag. `None` means the
    /// build could not tell, which is NOT "not a release" — see `build.rs`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<bool>,
    /// Whether the working tree was modified. `None` when unknowable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dirty: Option<bool>,
}

/// A build-script stamp read back; an empty value means the question could not
/// be answered, and stays absent rather than becoming a default.
fn stamped(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

/// This build of the shell.
pub fn current<R: Runtime>(app: &AppHandle<R>) -> BuildInfo {
    BuildInfo {
        version: app.package_info().version.to_string(),
        commit: stamped(env!("PA_BUILD_COMMIT")).map(str::to_string),
        release: stamped(env!("PA_BUILD_RELEASE")).map(|value| value == "1"),
        dirty: stamped(env!("PA_BUILD_DIRTY")).map(|value| value == "1"),
    }
}

impl BuildInfo {
    /// The version to SHOW. A build known not to be the tagged release is
    /// suffixed `-dev`, so `0.14.1` never means two things: at the tag it is the
    /// release, and ten commits later it is `0.14.1-dev`.
    pub fn version_label(&self) -> String {
        if self.release == Some(false) {
            format!("{}-dev", self.version)
        } else {
            self.version.clone()
        }
    }

    /// The commit as a label — `88b944c8`, or `88b944c8-dirty` for a modified
    /// tree. Absent rather than faked when the build never knew its commit.
    pub fn commit_label(&self) -> Option<String> {
        let short: String = self
            .commit
            .as_deref()?
            .chars()
            .take(SHORT_COMMIT_LENGTH)
            .collect();
        Some(if self.dirty == Some(true) {
            format!("{short}-dirty")
        } else {
            short
        })
    }
}

#[cfg(test)]
mod tests {
    use super::BuildInfo;

    fn info(release: Option<bool>, dirty: Option<bool>) -> BuildInfo {
        BuildInfo {
            version: "0.14.1".to_string(),
            commit: Some("88b944c8acdd03bb70c1f6cca7f9b3086de68b66".to_string()),
            release,
            dirty,
        }
    }

    /// The About panel's two lines, and the one claim it must not make: `-dev`
    /// says the build IS NOT the tagged release, so an unknown must not say it.
    #[test]
    fn labels_match_the_shared_rules() {
        assert_eq!(info(Some(true), Some(false)).version_label(), "0.14.1");
        assert_eq!(info(None, None).version_label(), "0.14.1");
        assert_eq!(info(Some(false), None).version_label(), "0.14.1-dev");
        assert_eq!(
            info(Some(false), Some(false)).commit_label().as_deref(),
            Some("88b944c8")
        );
        assert_eq!(
            info(Some(false), Some(true)).commit_label().as_deref(),
            Some("88b944c8-dirty")
        );
    }

    /// A build with no repository behind it names its version and stops.
    #[test]
    fn an_unknown_commit_has_no_label() {
        let unknown = BuildInfo {
            version: "0.14.1".to_string(),
            commit: None,
            release: None,
            dirty: None,
        };
        assert_eq!(unknown.commit_label(), None);
        assert_eq!(unknown.version_label(), "0.14.1");
    }

    /// The stamp `build.rs` wrote is readable from the binary: empty means the
    /// question was unanswerable, and must not become a bogus commit.
    #[test]
    fn the_build_stamp_is_either_a_sha_or_absent() {
        if let Some(commit) = super::stamped(env!("PA_BUILD_COMMIT")) {
            assert_eq!(commit.len(), 40, "{commit}");
            assert!(commit.chars().all(|c| c.is_ascii_hexdigit()), "{commit}");
        }
    }
}
