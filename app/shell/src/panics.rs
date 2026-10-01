//! What a Rust panic does in a shell that has no console.
//!
//! Two different problems wear the same word here.
//!
//! A panic is INVISIBLE in a shipped build. `stderr` for an app launched from
//! the Finder or the Home Screen goes nowhere anyone reads, the binary is
//! stripped, and `NSLog` does NOT reach the unified log from this process
//! (measured on macOS 26, so Console.app is not the answer either) — all that
//! survives a panic is a crash report full of raw offsets, and finding which
//! `unwrap` aborted the shipped shell meant disassembling one. [`install`] and
//! [`report_to`] answer that, in EVERY build rather than only in debug: a
//! process that misbehaves without saying why is a bug report nobody can act on.
//!
//! A panic is also UNRECOVERABLE wherever ObjC called us. WebKit and tao invoke
//! Rust through `extern "C"` function pointers, and a panic reaching one of
//! those frames aborts the process instead of unwinding past it — the callback
//! never gets to fail, only to kill the app. [`guard`] answers that for the
//! callbacks this crate owns by giving the panic somewhere to land: the same
//! answer the handler already gives when it decides not to act.
//!
//! Both of these need `panic = "unwind"`, which is why the release profile no
//! longer sets `panic = "abort"` — see the note beside it in `Cargo.toml`.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::Mutex;

/// Where a report is appended once the app can say where its config dir is.
/// Empty until then, which is not a gap worth closing with a second hook: the
/// only code that runs before it is Tauri's own builder assembly.
static REPORT_FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// How much of that file is kept. A panic that repeats — one per click on a bad
/// link — must not be able to fill a disk; the shell has already watched an
/// unbounded file do exactly that from the WebKit side. The newest report is the
/// one being read, so the file restarts rather than rotating.
const REPORT_LIMIT: u64 = 64 * 1024;

/// Route panic reports somewhere they can be read. Called once, first thing in
/// [`crate::run`], so it covers everything a launch does after that.
///
/// This REPLACES the default hook rather than wrapping it: the default prints to
/// a `stderr` that a bundled app does not have, so keeping it would only
/// duplicate the line in the one case — a run from a terminal — where ours is
/// already visible.
pub(crate) fn install() {
    panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column()));
        // Downcast rather than `payload_as_str`, which needs a newer toolchain
        // than the `rust-version` this crate promises. The two shapes below are
        // the only ones `panic!` produces.
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
            .unwrap_or("(no message)");
        let mut report = format!(
            "PANIC at {}: {message}",
            location.as_deref().unwrap_or("an unknown location"),
        );
        // Captured only when `RUST_BACKTRACE` asks for it, which is what
        // `capture` already means. A stripped release binary answers with bare
        // addresses, but those are exactly what the crash report gives too, and
        // this one arrives with the message beside it.
        let backtrace = std::backtrace::Backtrace::capture();
        if backtrace.status() == std::backtrace::BacktraceStatus::Captured {
            report.push_str(&format!("\n{backtrace}"));
        }
        emit(&report);
    }));
}

/// Start appending reports to `path` as well. Called from `setup`, which is the
/// first moment the app can resolve its own config dir.
pub(crate) fn report_to(path: PathBuf) {
    if let Ok(mut file) = REPORT_FILE.lock() {
        *file = Some(path);
    }
}

/// Say it everywhere it might be heard: the log line a terminal or a simulator
/// shows, and the file that is still there tomorrow.
fn emit(report: &str) {
    crate::log_line(report);
    let Ok(path) = REPORT_FILE.lock().map(|file| file.clone()) else {
        return;
    };
    let Some(path) = path else { return };
    let _ = append(&path, report);
}

fn append(path: &PathBuf, report: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let over_limit = fs::metadata(path).map(|at| at.len() > REPORT_LIMIT).unwrap_or(false);
    let mut file = OpenOptions::new()
        .create(true)
        .append(!over_limit)
        .write(true)
        .truncate(over_limit)
        .open(path)?;
    writeln!(file, "{report}\n")
}

/// Run the body of a callback ObjC will invoke, answering `fallback` if it
/// panics instead of letting the panic reach the frame that would abort.
///
/// `fallback` is a value rather than a closure because every caller's is a
/// constant, and because the recovery answer must not be able to fail in turn.
/// It is deliberately the REFUSING answer in both callers: a decision the shell
/// could not make is not a decision to go ahead.
///
/// A foreign exception is NOT caught here — `catch_unwind` aborts on one — and
/// does not need to be: wry wraps the ObjC calls that raise in its own catch,
/// which is what the profile change makes work again.
pub(crate) fn guard<T>(what: &str, fallback: T, body: impl FnOnce() -> T) -> T {
    match panic::catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => value,
        Err(_) => {
            // The hook has already reported the panic itself; this says what it
            // cost, which the hook cannot know.
            emit(&format!("{what} panicked -> refused"));
            fallback
        }
    }
}
