use std::path::PathBuf;

#[path = "src/server_url.rs"]
mod server_url;

fn configure_server_url() -> bool {
    println!("cargo:rerun-if-env-changed=PA_SHELL_SERVER_URL");
    let url = match std::env::var("PA_SHELL_SERVER_URL") {
        Ok(url) => url,
        Err(std::env::VarError::NotPresent) => return false,
        Err(err) => panic!("Invalid PA_SHELL_SERVER_URL: {err}"),
    };
    let origin = server_url::normalize_default_server(&url)
        .unwrap_or_else(|err| panic!("Invalid PA_SHELL_SERVER_URL: {err}"));
    println!("cargo:rustc-env=PA_SHELL_SERVER_URL={origin}");
    true
}

/// Use the same target-specific config loader as tauri-build, then inspect the
/// top-level identifier override passed by the CLI in TAURI_CONFIG.
fn warn_release_defaults(custom_server: bool) {
    println!("cargo:rerun-if-env-changed=TAURI_ENV_PLATFORM");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let release = std::env::var("PROFILE").is_ok_and(|profile| profile == "release");
    let cli_build = std::env::var_os("TAURI_ENV_PLATFORM").is_some();
    if release || cli_build {
        let target = tauri_utils::platform::Target::from_triple(
            &std::env::var("TARGET").expect("Cargo target"),
        );
        let (config, _) = tauri_utils::config::parse::read_from(
            target,
            &std::env::current_dir().expect("build directory"),
        ).expect("read Tauri config for identifier warning");
        let merge = std::env::var("TAURI_CONFIG").ok().map(|raw| {
            serde_json::from_str::<serde_json::Value>(&raw).expect("valid TAURI_CONFIG")
        });
        let identifier = merge.as_ref()
            .and_then(|config| config.get("identifier"))
            .or_else(|| config.get("identifier"))
            .and_then(serde_json::Value::as_str)
            .expect("Tauri bundle identifier");
        if identifier.starts_with("com.example.") {
            println!("cargo:warning=Placeholder bundle identifier {identifier}; use --config tauri.local.json for your deployment identity.");
        }
    }
    if release && !custom_server {
        println!("cargo:warning=PA_SHELL_SERVER_URL is unset in a release build; first launch will use http://localhost:8787.");
    }
}

/// Where the generated iOS project lives, and the scheme name inside it. Both are
/// exported by the Tauri CLI only while it is building the iOS target, so every
/// caller of this is a no-op for macOS.
fn ios_project() -> Option<(PathBuf, String)> {
    let project = std::env::var_os("TAURI_IOS_PROJECT_PATH").map(PathBuf::from)?;
    let app = std::env::var("TAURI_IOS_APP_NAME").ok()?;
    Some((project, app))
}

/// Which APNs environment a device token from this build belongs to.
///
/// It decides which of Apple's two push hosts will accept the token, and a
/// mismatch is reported as nothing more helpful than `BadDeviceToken` — so the
/// shell reports the value to the page (`push_registration`) and the page hands it
/// to the server along with the token, rather than the server guessing. A locally
/// installed or ad-hoc build is `development`; only a TestFlight/App Store
/// distribution is `production`.
fn apns_environment() -> String {
    println!("cargo:rerun-if-env-changed=APNS_ENVIRONMENT");
    std::env::var("APNS_ENVIRONMENT").unwrap_or_else(|_| "development".to_string())
}

/// Put `aps-environment` in the generated iOS project's entitlements.
///
/// Without it `registerForRemoteNotifications` fails outright ("no valid
/// aps-environment entitlement string found") and the app never gets a device
/// token — so this is what makes push exist at all. It is written from here rather
/// than by hand because `gen/` is generated output: `cargo tauri ios init`
/// recreates the file, and an edit made in it would be silently lost. The env vars
/// are the ones the Tauri CLI exports while building the iOS target, so this is a
/// no-op for every other target.
///
/// Read-modify-write, and safe against the deep-link plugin doing the same to the
/// same file: a crate's build script runs only after every dependency of that
/// crate is fully built, so this one runs last.
fn write_ios_entitlements(environment: &str) {
    let Some((project, app)) = ios_project() else {
        return;
    };
    let path = project
        .join(format!("{app}_iOS"))
        .join(format!("{app}_iOS.entitlements"));
    let mut entitlements = match plist::Value::from_file(&path) {
        Ok(plist::Value::Dictionary(dictionary)) => dictionary,
        // A project generated but not yet signed has no entitlements file at all.
        _ => plist::Dictionary::new(),
    };
    entitlements.insert("aps-environment".into(), environment.into());
    plist::Value::Dictionary(entitlements)
        .to_file_xml(&path)
        .unwrap_or_else(|err| panic!("failed to write {}: {err}", path.display()));
}

/// Put OUR app icon in the generated iOS project's asset catalog.
///
/// `cargo tauri ios init` fills `Assets.xcassets/AppIcon.appiconset` from
/// cargo-mobile2's Xcode template pack, which carries the TAURI logo — it never
/// looks at `icons/`. So a freshly generated project ships someone else's mark,
/// visibly, on the Home Screen and on every notification. `cargo tauri icon` does
/// write into that folder once it exists, but only when someone remembers to
/// re-run it after every regeneration, which is not a thing to rely on.
///
/// `icons/ios/` is the committed source (regenerate it with `cargo tauri icon`
/// while no `gen/apple` exists) and its file names are exactly the ones the
/// catalog's `Contents.json` already references, so this is a straight overwrite.
fn copy_ios_app_icon() {
    let Some((project, _)) = ios_project() else {
        return;
    };
    let source = PathBuf::from("icons/ios");
    println!("cargo:rerun-if-changed=icons/ios");
    let destination = project.join("Assets.xcassets/AppIcon.appiconset");
    let Ok(entries) = std::fs::read_dir(&source) else {
        panic!("{} is missing; regenerate it with `cargo tauri icon`", source.display());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "png") {
            continue;
        }
        let target = destination.join(entry.file_name());
        std::fs::copy(&path, &target)
            .unwrap_or_else(|err| panic!("failed to write {}: {err}", target.display()));
    }
}

/// Ask git one question about the repository this crate is being built from.
///
/// The shell is built by hand from a checkout, so git is the only thing that
/// knows which commit an installed .app came from — and a signed binary cannot
/// ask later.
///
/// `None` means the question could not be ASKED (no git, no repository), while
/// `Some("")` is a real answer of nothing. The difference is the whole point: it
/// separates a clean tree from an unknown one, and an untagged commit from one
/// whose tags were never readable.
fn git_raw(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(env!("CARGO_MANIFEST_DIR"))
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8(output.stdout).ok()?.trim().to_string())
}

/// {@link git_raw} for the questions whose empty answer is no answer.
fn git(args: &[&str]) -> Option<String> {
    git_raw(args).filter(|text| !text.is_empty())
}

/// Tell cargo what makes the stamp stale.
///
/// None of it is a file this crate compiles, so without these the build script is
/// skipped and an old stamp is relinked. All four matter, and the refs are the
/// subtle pair: cutting a release TAGS a commit that may already be built, so
/// fetching that tag has to be able to turn a `-dev` build into the release it
/// now is. Tags live in `packed-refs` once packed and under `refs/tags` before
/// that, and a linked worktree keeps them in the COMMON dir while holding its own
/// `HEAD` and `index` — so the paths are asked for rather than guessed. Nothing
/// to watch when there is no repository, which is also when there is no stamp.
fn watch_git_state() {
    let per_worktree = git(&["rev-parse", "--path-format=absolute", "--git-dir"]);
    let common = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    for (dir, entries) in [
        (per_worktree, ["HEAD", "index"].as_slice()),
        (common, ["packed-refs", "refs/tags"].as_slice()),
    ] {
        let Some(dir) = dir else { continue };
        for entry in entries {
            println!("cargo:rerun-if-changed={dir}/{entry}");
        }
    }
}

/// Stamp this build's commit, release-ness and cleanliness into the binary.
///
/// The three answers mirror `app/server/src/buildInfo.ts` so the About panel and
/// Settings → About say the same kind of thing about every runtime: the commit,
/// whether it carries the `v<version>` tag (an actual release rather than a build
/// off main), and whether the tree was modified. Absent answers stay absent —
/// `shell_info` and the menu both treat an empty value as "unknown" rather than
/// printing one.
///
/// The version itself is NOT stamped here: `tauri.conf.json` declares it (which
/// is what `package_info()` and the bundle use), and `pnpm run version:set` owns
/// every copy of it in the repository.
fn write_build_stamp() {
    watch_git_state();
    println!("cargo:rerun-if-env-changed=PA_BUILD_COMMIT");

    // An exported tree with no repository can still be identified if whoever
    // exported it says which commit it was.
    let commit = std::env::var("PA_BUILD_COMMIT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git(&["rev-parse", "HEAD"]))
        .unwrap_or_default();
    println!("cargo:rustc-env=PA_BUILD_COMMIT={commit}");

    // Tri-state, like the wire type: "1" is the tagged release, "0" is positively
    // not it, and empty means git could not be asked at all.
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    // `git_raw`, not `git`: no tags at HEAD is the ANSWER "not a release", and
    // must not read as the unanswerable case.
    let release = match git_raw(&["tag", "--points-at", "HEAD"]) {
        Some(tags) => {
            let tagged = tags.lines().any(|tag| tag == format!("v{version}") || tag == version);
            if tagged { "1" } else { "0" }
        }
        // No repository, so no tags to check — and a commit taken from the
        // environment says nothing about tags either.
        None => "",
    };
    println!("cargo:rustc-env=PA_BUILD_RELEASE={release}");

    // Tracked files only: an untracked scratch file is not a different build.
    let dirty = match git_raw(&["status", "--porcelain", "-uno"]) {
        Some(changes) if changes.is_empty() => "0",
        Some(_) => "1",
        None => "",
    };
    println!("cargo:rustc-env=PA_BUILD_DIRTY={dirty}");
}

/// Declaring the commands here is what makes them ADDRESSABLE by the ACL.
///
/// Undeclared app commands are implicitly available to every local window and to
/// no remote one — and a remote origin is the only kind this shell has, since the
/// app is loaded from the server. Declaring them generates an `allow-*`
/// permission per command, which `capabilities/` then hands out per origin: the
/// bundled bootstrap gets the ones that re-point the shell, the hosted app gets
/// only what it needs to know about its own chrome.
fn main() {
    let custom_server = configure_server_url();
    warn_release_defaults(custom_server);
    let environment = apns_environment();
    println!("cargo:rustc-env=APNS_ENVIRONMENT={environment}");
    write_build_stamp();
    write_ios_entitlements(&environment);
    copy_ios_app_icon();

    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "shell_info",
                "window_loaded",
                "window_ready",
                "open_window",
                "open_served_file",
                "get_server_url",
                "set_server_url",
                "start_port_forward",
                "list_port_forwards",
                "stop_port_forward",
                "open_port_forward_url",
                "probe_server",
                "push_registration",
                "notify",
                "take_pending_open_url",
            ]),
        ),
    )
    .expect("failed to run tauri-build");
}
