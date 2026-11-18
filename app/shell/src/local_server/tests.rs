//! Lifecycle tests. The child is this test binary run again as a fake server
//! (`fake_child_entry`), so every path — readiness, refusal, timeout, crash,
//! shutdown of descendants — runs real processes, pipes and sockets.
//!
//! `bundled_runtime_lifecycle` is the same launcher against the REAL packaged
//! server; it is ignored unless `PA_LOCAL_RUNTIME_DIR` names one.

use super::*;
use std::net::TcpListener;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

const MODE: &str = "PA_FAKE_SERVER_MODE";
const PIDS: &str = "PA_FAKE_SERVER_PIDS";
const REPORT_PORT: &str = "PA_FAKE_REPORT_PORT";

/// A scratch directory removed on drop.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "pa-local-server-{name}-{}-{}",
            std::process::id(),
            random_hex(4).unwrap()
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn fake_spec(scratch: &Scratch, mode: &str) -> LaunchSpec {
    let paths = local_paths(&scratch.0.join("support"));
    let mut ambient = ambient_env(std::env::vars());
    ambient.push((MODE.into(), mode.into()));
    ambient.push((
        PIDS.into(),
        scratch.0.join("pids").to_string_lossy().into_owned(),
    ));
    LaunchSpec {
        program: std::env::current_exe().unwrap(),
        args: vec![
            "local_server::tests::fake_child_entry".into(),
            "--exact".into(),
            "--nocapture".into(),
            "--test-threads=1".into(),
        ],
        runtime_dir: None,
        state_dir: paths.state_dir,
        data_dir: paths.data_dir,
        log_path: paths.log_path,
        workspace: scratch.0.clone(),
        preferred_port: None,
        startup_timeout: Duration::from_secs(20),
        ambient,
    }
}

fn start(spec: &LaunchSpec) -> Result<Launched, LaunchError> {
    launch(spec, &AtomicU64::new(0), 0)
}

fn recorded_pids(scratch: &Scratch) -> Vec<libc::pid_t> {
    let path = scratch.0.join("pids");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = fs::read_to_string(&path) {
            if text.ends_with('\n') {
                return text.lines().filter_map(|line| line.parse().ok()).collect();
            }
        }
        assert!(
            Instant::now() < deadline,
            "fake server never recorded its descendants"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn gone(pid: libc::pid_t) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        // A zombie still answers signal 0 until its new parent reaps it.
        let zombie = fs::read_to_string(format!("/proc/{pid}/stat"))
            .map(|stat| {
                stat.rsplit(')')
                    .next()
                    .unwrap_or("")
                    .trim_start()
                    .starts_with('Z')
            })
            .unwrap_or(false);
        if !alive(pid) || zombie {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

/// The fake server. A no-op in an ordinary test run; when the launcher runs
/// this binary with `PA_FAKE_SERVER_MODE`, it plays a server that behaves (or
/// misbehaves) as the mode says.
#[test]
fn fake_child_entry() {
    let Ok(mode) = std::env::var(MODE) else {
        return;
    };
    fake_server(&mode);
}

fn fake_server(mode: &str) -> ! {
    use std::io::Write as _;
    // SAFETY: fd 3 is the inherited readiness pipe, owned by nobody else here.
    let mut ready = unsafe { File::from_raw_fd(READY_FD) };
    let nonce = std::env::var("ASSISTANT_SUPERVISOR_NONCE").unwrap_or_default();
    let pid = std::process::id();
    match mode {
        "exit" => {
            eprintln!("[assistant] Required host tools are missing or too old: bash 3.2.57 < 5");
            std::process::exit(1);
        }
        "silent" => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
        "close" => {
            drop(ready);
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        _ => {}
    }
    if mode == "adopt" {
        let port: u16 = std::env::var(REPORT_PORT).unwrap().parse().unwrap();
        let _ = writeln!(
            ready,
            r#"{{"type":"pandeck-ready","nonce":"{nonce}","pid":{pid},"port":{port}}}"#
        );
        loop {
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    if mode == "ignore-term" {
        // SAFETY: installing SIG_IGN has no preconditions.
        unsafe {
            libc::signal(libc::SIGTERM, libc::SIG_IGN);
        }
    }

    // Same rule as the real server: the port is a preference, never adopted.
    let preferred: u16 = std::env::var("ASSISTANT_PORT").unwrap().parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", preferred))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
        .unwrap();
    let port = listener.local_addr().unwrap().port();

    // One descendant in this group, one that left it, as agents do.
    let same_group = Command::new("sleep").arg("300").spawn().unwrap();
    let own_group = Command::new("sleep")
        .arg("300")
        .process_group(0)
        .spawn()
        .unwrap();
    let pids = std::env::var(PIDS).unwrap();
    fs::write(&pids, format!("{}\n{}\n", same_group.id(), own_group.id())).unwrap();

    // Lifeline: the shell's end of stdin closing means it is gone.
    std::thread::spawn(|| {
        let mut sink = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut sink);
        std::process::exit(0);
    });

    let (claimed_nonce, claimed_pid) = match mode {
        "wrong-nonce" => ("0".repeat(64), pid),
        "wrong-pid" => (nonce.clone(), pid + 1),
        _ => (nonce.clone(), pid),
    };
    writeln!(
        ready,
        r#"{{"type":"pandeck-ready","nonce":"{claimed_nonce}","pid":{claimed_pid},"port":{port}}}"#
    )
    .unwrap();
    drop(ready);

    let open = mode == "no-auth";
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut request = Vec::new();
        let mut byte = [0u8; 1];
        while !request.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
            request.push(byte[0]);
        }
        let text = String::from_utf8_lossy(&request);
        let path = text.split_whitespace().nth(1).unwrap_or("/");
        let (status, body) = if path == "/api/health" || open {
            ("200 OK", r#"{"ok":true}"#)
        } else {
            ("401 Unauthorized", r#"{"error":"Unauthorized"}"#)
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }
    unreachable!()
}

#[test]
fn ready_child_reports_its_bound_port_and_is_verified() {
    let scratch = Scratch::new("ready");
    let spec = fake_spec(&scratch, "ready");
    let launched = start(&spec).unwrap();
    assert_ne!(launched.port, 0, "port zero must resolve to the bound port");
    assert_eq!(
        launched.origin,
        format!("http://127.0.0.1:{}", launched.port)
    );
    assert_eq!(http_get(launched.port, "/api/health").unwrap().0, 200);
    // Owner-only state outside any bundle.
    for dir in [&spec.state_dir, &spec.data_dir] {
        assert_eq!(
            fs::metadata(dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert_eq!(
        fs::metadata(&spec.log_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let report = launched.shutdown(SHUTDOWN_GRACE);
    let log = fs::read_to_string(&spec.log_path).unwrap();
    assert!(log.contains("[shell] local server ready"), "{log}");
    assert!(log.contains("[shell] local server stopped"), "{log}");
    let nonce_free = !log.lines().any(|line| line.contains("pandeck-ready"));
    assert!(nonce_free, "the readiness line must never reach the log");
    assert_eq!(report.survivors, 0);
}

#[test]
fn an_occupied_preferred_port_is_never_adopted() {
    let scratch = Scratch::new("occupied");
    let unrelated = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let occupied = unrelated.local_addr().unwrap().port();
    let mut spec = fake_spec(&scratch, "ready");
    spec.preferred_port = Some(occupied);
    let launched = start(&spec).unwrap();
    assert_ne!(launched.port, occupied);
    // The unrelated listener is untouched and still the one on that port.
    unrelated.set_nonblocking(true).unwrap();
    let probe = std::thread::spawn(move || TcpStream::connect(("127.0.0.1", occupied)).is_ok());
    assert!(probe.join().unwrap());
    assert!(unrelated.accept().is_ok());
    launched.shutdown(SHUTDOWN_GRACE);
}

#[test]
fn readiness_naming_an_unrelated_listener_is_refused() {
    let scratch = Scratch::new("adopt");
    // Something else on the machine answering health on its own port.
    let unrelated = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = unrelated.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in unrelated.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            );
        }
    });
    let mut spec = fake_spec(&scratch, "adopt");
    spec.ambient.push((REPORT_PORT.into(), port.to_string()));
    match start(&spec) {
        Err(LaunchError::Unverified(message)) => assert!(message.contains("not 401"), "{message}"),
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("adopted a listener the child does not own"),
    }
}

#[test]
fn readiness_with_a_wrong_nonce_or_pid_is_refused() {
    for mode in ["wrong-nonce", "wrong-pid"] {
        let scratch = Scratch::new(mode);
        match start(&fake_spec(&scratch, mode)) {
            Err(LaunchError::Readiness(_)) => {}
            Err(other) => panic!("{mode}: unexpected error {other}"),
            Ok(_) => panic!("{mode}: accepted forged readiness"),
        }
        // Even its descendants were cleaned up with it.
        for pid in recorded_pids(&scratch) {
            assert!(
                gone(pid),
                "{mode}: descendant {pid} survived a refused start"
            );
        }
    }
}

#[test]
fn a_listener_without_the_auth_gate_is_refused() {
    let scratch = Scratch::new("no-auth");
    match start(&fake_spec(&scratch, "no-auth")) {
        Err(LaunchError::Unverified(message)) => assert!(message.contains("200"), "{message}"),
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("accepted a server answering unauthenticated API requests"),
    }
}

#[test]
fn exit_during_startup_quotes_the_log() {
    let scratch = Scratch::new("exit");
    match start(&fake_spec(&scratch, "exit")) {
        Err(error @ LaunchError::Exited { .. }) => {
            let text = error.to_string();
            assert!(text.contains("exit code 1"), "{text}");
            assert!(text.contains("Required host tools are missing"), "{text}");
            assert!(!text.contains("[shell]"), "{text}");
        }
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("a crashed child was reported ready"),
    }
}

#[test]
fn a_silent_child_times_out_and_is_stopped() {
    let scratch = Scratch::new("silent");
    let mut spec = fake_spec(&scratch, "silent");
    spec.startup_timeout = Duration::from_millis(1500);
    let started = Instant::now();
    match start(&spec) {
        Err(LaunchError::TimedOut { .. }) => {}
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("a silent child was reported ready"),
    }
    assert!(
        started.elapsed() < Duration::from_secs(12),
        "timeout is bounded"
    );
    let log = fs::read_to_string(&spec.log_path).unwrap();
    assert!(log.contains("start failed (timed out); graceful"), "{log}");
}

#[test]
fn a_closed_readiness_pipe_is_refused() {
    let scratch = Scratch::new("close");
    match start(&fake_spec(&scratch, "close")) {
        Err(LaunchError::Readiness(message)) => assert!(message.contains("closed"), "{message}"),
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("accepted a child that never reported"),
    }
}

#[test]
fn a_stop_cancels_a_starting_child() {
    let scratch = Scratch::new("cancel");
    let spec = fake_spec(&scratch, "silent");
    let generation = Arc::new(AtomicU64::new(7));
    let stopper = Arc::clone(&generation);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        stopper.fetch_add(1, Ordering::SeqCst);
    });
    let started = Instant::now();
    match launch(&spec, &generation, 7) {
        Err(LaunchError::Cancelled) => {}
        Err(other) => panic!("unexpected error {other}"),
        Ok(_) => panic!("a cancelled start became ready"),
    }
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[test]
fn shutdown_reaches_descendants_in_other_process_groups() {
    let scratch = Scratch::new("tree");
    let launched = start(&fake_spec(&scratch, "ready")).unwrap();
    let pids = recorded_pids(&scratch);
    assert_eq!(pids.len(), 2);
    let child = launched.pid as libc::pid_t;
    let report = launched.shutdown(SHUTDOWN_GRACE);
    assert!(report.graceful, "{report}");
    assert!(gone(child));
    for pid in pids {
        assert!(gone(pid), "descendant {pid} outlived shutdown: {report}");
    }
}

#[test]
fn a_child_ignoring_sigterm_is_killed_after_the_grace() {
    let scratch = Scratch::new("stubborn");
    let launched = start(&fake_spec(&scratch, "ignore-term")).unwrap();
    let pids = recorded_pids(&scratch);
    let child = launched.pid as libc::pid_t;
    let started = Instant::now();
    let mut launched = launched;
    // Keep the lifeline open so only signals can stop it.
    let lifeline = launched.lifeline.take();
    let report = stop_child(&mut launched.child, None, Duration::from_millis(600));
    drop(lifeline);
    assert!(!report.graceful, "{report}");
    assert!(report.status.contains("signal 9"), "{report}");
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "stop is bounded"
    );
    assert!(gone(child));
    for pid in pids {
        assert!(gone(pid), "descendant {pid} outlived a forced stop");
    }
}

#[test]
fn closing_the_lifeline_stops_the_child() {
    let scratch = Scratch::new("lifeline");
    let mut launched = start(&fake_spec(&scratch, "ready")).unwrap();
    drop(launched.lifeline.take());
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = launched.try_exited() {
            break status;
        }
        assert!(Instant::now() < deadline, "the child ignored its lifeline");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success());
    let pids = recorded_pids(&scratch);
    let report = launched.reap_after_exit();
    assert!(report.graceful, "{report}");
    // As after a crash, only the group is reachable once the child is gone.
    assert!(gone(pids[0]), "group member outlived reaping: {report}");
    signal(pids[1], libc::SIGKILL);
}

#[test]
fn an_unexpected_exit_is_observed_and_reaped() {
    let scratch = Scratch::new("crash");
    let mut launched = start(&fake_spec(&scratch, "ready")).unwrap();
    let pids = recorded_pids(&scratch);
    signal(launched.pid as libc::pid_t, libc::SIGKILL);
    let deadline = Instant::now() + Duration::from_secs(5);
    while launched.try_exited().is_none() {
        assert!(Instant::now() < deadline, "crash not observed");
        std::thread::sleep(Duration::from_millis(20));
    }
    // The child is gone, so only its group remains reachable; the descendant
    // that left the group is the documented gap for a crash.
    let same_group = pids[0];
    launched.reap_after_exit();
    assert!(gone(same_group));
    signal(pids[1], libc::SIGKILL);
}

#[test]
fn readiness_parsing_checks_type_nonce_pid_and_port() {
    let nonce = "ab".repeat(32);
    let line = |nonce: &str, pid: u32, port: i64| {
        format!(r#"{{"type":"pandeck-ready","nonce":"{nonce}","pid":{pid},"port":{port}}}"#)
    };
    assert_eq!(
        parse_readiness(&line(&nonce, 42, 4100), &nonce, 42).unwrap(),
        4100
    );
    for (candidate, pid) in [
        (line(&nonce, 42, 0), 42),
        (line(&nonce, 42, 70000), 42),
        (line(&nonce, 43, 4100), 42),
        (line(&"cd".repeat(32), 42, 4100), 42),
        (line(&nonce[..10], 42, 4100), 42),
        (r#"{"type":"ready","port":4100}"#.to_string(), 42),
        ("not json".to_string(), 42),
    ] {
        let error = parse_readiness(&candidate, &nonce, pid).unwrap_err();
        assert!(
            !error.to_string().contains(&nonce),
            "errors must not echo the nonce"
        );
    }
}

#[test]
fn local_paths_live_under_app_support_and_ignore_the_mode() {
    let support = Path::new("/Users/someone/Library/Application Support/com.example.pandeck");
    let paths = local_paths(support);
    assert_eq!(paths.state_dir, support.join("local-server"));
    assert_eq!(paths.data_dir, support.join("local-server/data"));
    assert_eq!(paths.log_path, support.join("local-server/logs/server.log"));
    assert_eq!(
        local_paths(support),
        paths,
        "the same data in every mode and launch"
    );
}

#[test]
fn ambient_env_passes_only_the_allow_list() {
    let vars = [
        ("PATH", "/opt/homebrew/bin:/usr/bin"),
        ("HOME", "/Users/someone"),
        ("LANG", "en_US.UTF-8"),
        ("ANTHROPIC_API_KEY", "secret"),
        ("ASSISTANT_TOKEN", "secret"),
        ("ASSISTANT_GATEWAY_RELAY", "/tmp/relay.sock,8790"),
        ("DATA_DIR", "/elsewhere"),
        ("GITHUB_TOKEN", "secret"),
    ]
    .map(|(k, v)| (k.to_string(), v.to_string()));
    let names: Vec<String> = ambient_env(vars).into_iter().map(|(k, _)| k).collect();
    assert_eq!(names, ["PATH", "HOME", "LANG"]);
}

#[test]
fn an_incomplete_runtime_is_refused_before_spawning() {
    let scratch = Scratch::new("layout");
    let runtime = scratch.0.join("runtime");
    assert!(matches!(
        check_runtime(Path::new("relative")),
        Err(LaunchError::Layout(_))
    ));
    match check_runtime(&runtime) {
        Err(LaunchError::Layout(message)) => assert!(message.contains(RUNTIME_EXECUTABLE)),
        other => panic!("unexpected {other:?}"),
    }
    for file in REQUIRED_RUNTIME_FILES {
        let path = runtime.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "").unwrap();
    }
    match check_runtime(&runtime) {
        Err(LaunchError::Layout(message)) => assert!(message.contains("not executable")),
        other => panic!("unexpected {other:?}"),
    }
    fs::set_permissions(
        runtime.join(RUNTIME_EXECUTABLE),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    assert!(check_runtime(&runtime).is_ok());
}

/// The headless receipt: this launcher against a REAL packaged server, as the
/// app would run it from its resource directory. No window, no accounts, no
/// model requests. Run with
/// `PA_LOCAL_RUNTIME_DIR=<runtime> cargo test bundled_runtime -- --ignored --nocapture`.
#[test]
#[ignore = "needs PA_LOCAL_RUNTIME_DIR pointing at a packaged server"]
fn bundled_runtime_lifecycle() {
    let runtime = PathBuf::from(
        std::env::var("PA_LOCAL_RUNTIME_DIR").expect("PA_LOCAL_RUNTIME_DIR names the runtime"),
    );
    let scratch = Scratch::new("bundled");
    let home = scratch.0.join("home");
    fs::create_dir_all(&home).unwrap();
    let paths = local_paths(&scratch.0.join("Application Support/pandeck"));
    let ambient: Vec<(String, String)> = ambient_env(std::env::vars())
        .into_iter()
        .map(|(k, v)| {
            if k == "HOME" {
                (k, home.to_string_lossy().into_owned())
            } else {
                (k, v)
            }
        })
        .collect();
    let spec = |preferred| {
        LaunchSpec::bundled(&runtime, &paths, &home, preferred, ambient.clone()).unwrap()
    };
    let step = |label: &str| eprintln!("[receipt] {label}");

    let started = Instant::now();
    let first = start(&spec(None)).unwrap_or_else(|err| panic!("launch failed: {err}"));
    step(&format!(
        "ready in {:?}: pid {} on {} (port zero resolved by the child)",
        started.elapsed(),
        first.pid,
        first.origin
    ));
    let port = first.port;
    let token = fs::read_to_string(paths.data_dir.join(".assistant-token")).unwrap();
    let token = token.trim();
    assert!(token.len() >= 32);
    let token_mode = fs::metadata(paths.data_dir.join(".assistant-token"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(token_mode & 0o777, 0o600);
    let host = format!("127.0.0.1:{port}");
    let bearer = format!("Bearer {token}");
    assert_eq!(http_get(port, "/api/receipt").unwrap().0, 401);
    let authed = http_request(port, "/api/receipt", &host, &[("Authorization", &bearer)])
        .unwrap()
        .0;
    assert!(
        authed != 401 && authed != 403,
        "valid token refused: {authed}"
    );
    let hostile = http_request(
        port,
        "/api/receipt",
        &host,
        &[
            ("Authorization", &bearer),
            ("Origin", "https://hostile.invalid"),
        ],
    )
    .unwrap()
    .0;
    assert_eq!(hostile, 403);
    let rebinding = http_request(port, "/", &format!("rebind.invalid:{port}"), &[])
        .unwrap()
        .0;
    assert_eq!(rebinding, 421);
    let index = http_get(port, "/").unwrap();
    assert_eq!(index.0, 200);
    step(&format!(
        "identity/auth: health 200, no token 401, token {authed}, hostile origin 403, rebinding host 421"
    ));

    // A second instance on the same data refuses, and never steals the port.
    match start(&spec(Some(port))) {
        Err(LaunchError::Exited { log_tail, .. }) => {
            assert!(log_tail.contains("Another Pandeck server"), "{log_tail}");
            step("second launch on the same data refused by the boot lock");
        }
        Err(other) => panic!("unexpected second-launch error: {other}"),
        Ok(_) => panic!("two servers on one DATA_DIR"),
    }

    let stopped = Instant::now();
    let report = first.shutdown(SHUTDOWN_GRACE);
    assert!(report.graceful, "{report}");
    assert_eq!(report.survivors, 0);
    step(&format!(
        "SIGTERM shutdown in {:?}: {report}",
        stopped.elapsed()
    ));
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_err(),
        "listener outlived shutdown"
    );

    // Relaunch on the remembered port: same origin, same data, same token.
    let second = start(&spec(Some(port))).unwrap();
    assert_eq!(second.port, port);
    let again = fs::read_to_string(paths.data_dir.join(".assistant-token")).unwrap();
    assert_eq!(again.trim(), token);
    step("relaunch kept the origin, data and token");

    // Lifeline: the shell vanishing makes the server drain on its own.
    let mut second = second;
    drop(second.lifeline.take());
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while second.try_exited().is_none() {
        assert!(Instant::now() < deadline, "server ignored its lifeline");
        std::thread::sleep(Duration::from_millis(50));
    }
    let report = second.reap_after_exit();
    step(&format!("lifeline EOF stopped the server: {report}"));

    // Someone else on the remembered port: the server binds another and says so.
    let squatter = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let third = start(&spec(Some(port))).unwrap();
    assert_ne!(third.port, port);
    assert!(squatter.local_addr().is_ok());
    step(&format!(
        "occupied port {port} not adopted; child bound {}",
        third.port
    ));
    let report = third.shutdown(SHUTDOWN_GRACE);
    assert!(report.graceful, "{report}");

    assert!(
        !runtime.join("assistant-data").exists(),
        "wrote data into the runtime"
    );
    assert!(
        !home.join("assistant-data").exists(),
        "wrote data into the workspace"
    );
    step("no data written inside the runtime or the workspace");
}
