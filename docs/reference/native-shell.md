# Native shell — implementation reference

A descriptive snapshot of what the modules in `app/shell/` own; the rules an
agent must not violate stay in that folder's `CLAUDE.md`. Correct or delete a
section here when the code moves on. Relative paths in the body are relative to
`app/shell/`.

## Purpose

A Rust/Tauri window around the hosted `app/web` build, built for macOS and iOS
from one crate. The window loads the app from the server exactly as a browser
would, so shipping a UI change means deploying the server and nothing else; the
shell is rebuilt only when it grows a new NATIVE capability. What it owns is the
handful of things a browser tab cannot give us: microphone capture that survives
a relaunch, OS notifications that open the thing they are about, a `pa://` URL
scheme, window chrome the page draws into, a menu bar, windows that open the way
a native app's do, and a page to fall back to when the server cannot be reached.

The iPhone is the reason the shell exists at all. Safari there does not persist
a microphone grant — even in an installed Home Screen app it re-prompts on every
`getUserMedia`, so dictation costs a permission dialog per utterance — and a
WKWebView whose host app declares `NSMicrophoneUsageDescription` does not: wry
answers WebKit's capture request with `Grant` unconditionally
(`WryWebViewUIDelegate`), leaving only the one-time iOS system prompt. That is
also why `speechCapture.ts` skips its stream-parking here
(`microphoneGrantPersists`).

## Module ownership

- `src/lib.rs` owns the window factory, the app commands, and the initialization
  script. `build_window` builds EVERY window from one definition — same
  navigation policy, same overlay title bar, same background colour — and its
  two callers differ only in where they point it: `build_app_window` at the
  server, `open_bootstrap_window` at the bundled page. Windows are labelled
  `main`, then `window1`, `window2` …, and that prefix is what `capabilities/`
  matches; a label outside those patterns produces a window that loads the app
  and then silently has no IPC, which presents as a broken microphone rather
  than as a misconfiguration. Popups from `window.open` keep the separate
  `popup*` prefix and are deliberately unmatched: they carry someone else's
  origin.
- `open_child_window` answers a `window.open` for an allowed URL, and three
  things about it are load-bearing. It builds the child itself rather than
  answering `Allow`, because `Allow` lets WebKit make a plain `WKWebView` from
  the opener's configuration and the first `ipc://` request then reads ivars
  only wry's subclass has. It reuses that configuration — WebKit requires the
  child be created with the one it handed over — but replaces its
  `WKUserContentController` first: the opener's controller already carries wry's
  `ipc` script-message handler, and wry adding a second raises
  `NSInvalidArgumentException`. wry catches that, yet only where Rust can
  unwind, so under the release profile's then-`panic = "abort"` it hit a
  nounwind frame and aborted — every `_blank` link to an assistant URL killed
  the shipped app while `cargo run` survived. And it probes the built window
  (`WebviewWindow::url`) before answering `Create`: `build` reports what TAURI
  could do, a window the RUNTIME failed to create comes back `Ok` all the same,
  and `Create` with one of those unwraps a `None` inside `tauri-runtime-wry`. A
  child that cannot be built goes to the browser, since a denied new-window
  request is silent in the page.
- `src/panics.rs` owns the two things a panic means in a shell with no console,
  which are not the same thing.
  - It is INVISIBLE. `stderr` for an app launched from the Finder or the Home
    Screen goes nowhere, the binary is stripped, and `NSLog` does not reach the
    unified log from this process either — measured, not assumed, so Console.app
    is no substitute — which leaves a panic nothing but a crash report full of
    raw offsets. Finding which `unwrap` aborted the shipped shell meant
    disassembling one. `install` sets a hook that reports through `log_line`,
    and `report_to` adds `panic.log` beside `shell.json` once `setup` can
    resolve the config dir: the log line is what a terminal or the simulator
    shows, the file is what is still there tomorrow. Every build, not just debug
    — a process that misbehaves without saying why is a bug report nobody can
    act on. The file restarts past 64 KB, because a panic that repeats once per
    click must not be able to fill a disk.
  - It is UNRECOVERABLE wherever ObjC called us. WebKit and tao invoke Rust
    through `extern "C"` function pointers, and a panic reaching one of those
    aborts rather than unwinding past it, so the callback never gets to merely
    fail. `guard` gives it somewhere to land — the refusing answer the handler
    already has — and wraps the navigation and new-window handlers, the two
    callbacks that take a URL some page chose.
  - Both need `panic = "unwind"`, which is the second reason the release profile
    dropped `panic = "abort"`. The first is that `abort` makes every ObjC
    exception wry deliberately catches fatal, and only in a shipped build.
- An app window goes STRAIGHT to the server, hidden until its page reports in.
  It used to start on `bootstrap/index.html`, which probed `/api/health` and
  then `location.replace`d into the app — so every window, including each
  `File → New Window`, paid a spinner, an HTTP round trip and a second full
  document load before the app could begin. Worse, a failed probe refused to
  navigate at all, which denied the app the one situation its service worker and
  `localStorage` shell cache exist for. Nothing on the web side got faster here:
  `createInitialState` already hydrates from `assistant.appShellCache.v1`
  synchronously, and the hop in front of it was the whole cost.
- `WebviewUrl::External` is what makes the direct load possible, and the ACL
  follows the URL rather than the label: `capabilities/remote.json` is a runtime
  template populated with the trusted origins by `config::trust_server`, while
  `capabilities/default.json` carries no `remote` block and so applies only to
  the local context. A window that never visits the bootstrap page therefore
  never holds the server-repointing grants, and one navigated BACK there picks
  them up — the same mechanism that used to work in the other direction.
- `app_url` resolves where a window starts and `safe_path` guards the optional
  path: one leading slash, no protocol-relative `//`, no backslashes, mirroring
  what `app/web/src/lib/openTarget.ts` does to its own input. The page is the
  only caller today, but the shell already accepts targets from anything on the
  machine through `pa://`, so a path is checked rather than trusted for being
  close by. The joined URL is re-tested against `is_allowed`, so nothing leaves
  that function which the navigation guard would then refuse.
- `background_throttling` is `Disabled`, and that is load-bearing rather than a
  tuning knob: the default policy SUSPENDS a webview that is not in a visible
  window, and an app window starts hidden waiting for its page to report — which
  a suspended page cannot do. It also keeps a minimized window's socket and
  stream alive where the default would have dropped them after a few minutes.
  macOS 14+/iOS 17+; below that `ready`'s show deadline is the safety net.
- The background colour is the page's own (`#0b0c10` / `#f7f8fa`, the values
  `app/web/index.html` sets inline and declares as its `theme-color`), so the
  frame behind a page that has not painted is the app's colour rather than a
  white flash. macOS takes it for the WINDOW layer only — the webview layer is
  unimplemented there — which is exactly the layer that would otherwise flash;
  iOS ignores it on both, and nothing there is hidden long enough to matter.
- Commands: `shell_info` (platform, server URL, chrome insets, build identity),
  `window_loaded`, `window_ready`, `open_window`, `open_served_file`,
  `push_registration` (notification permission + APNs device token) and `notify`
  are granted to the hosted app; `get_server_url`, `set_server_url` and
  `probe_server` are the bootstrap page's alone. `window_loaded` is granted to
  the bootstrap page as well, for the narrow reason that the shell's init script
  runs there too and would otherwise log a refused invoke on every load.
  `window_ready` carries the page's theme as well as revealing the window,
  because the shell paints the next window's frame before any page exists to be
  asked. `open_window` is the page's only door to a second window — it holds no
  window API of its own. `open_served_file` is the sole same-origin opener: it
  accepts only token-free `/api/file-grants/<opaque id>/<file>` URLs on the
  configured server's exact origin. Raw token URLs, foreign origins, and legacy
  `?download=1` toggles are refused before the OS opener runs; attachment versus
  inline delivery is bound to the opaque server-side grant.
- `src/buildinfo.rs` owns which build the shell IS, for two consumers: the page
  (through `shell_info.build`, mirroring `BuildInfo` in
  `app/shared/buildInfo.ts`) and the macOS About panel. The version comes from
  `tauri.conf.json` through `package_info()` — one declaration, owned by
  `pnpm run version:set` — and the commit, release-ness and dirtiness come from
  the `PA_BUILD_*` stamp `build.rs` writes, since a signed binary cannot ask git
  afterwards. An empty stamp means the question was unanswerable and stays
  unanswered: `version_label()` only appends `-dev` when the build KNOWS it is
  not the tagged release, which is why `build.rs` separates "no tags at HEAD"
  from "no repository to ask". The About panel's two lines are macOS's own:
  `version` is the `Version …` line and `short_version` is the build in
  parentheses after it, so a release reads `Version 0.14.1 (88b944c8)` and a
  local build `Version 0.14.1-dev (88b944c8-dirty)`.
- `src/ready.rs` owns when a window may be seen, and what happens when nothing
  ever loads. Hiding it is the point — a window that appears instantly and then
  spends a round trip admitting it has nothing in it is what a browser tab does
  — but hiding one means owning the failure, and the two signals that answer it
  come from very different places.
  - `window_loaded` is raised by the SHELL'S OWN initialization script, so it is
    true of whatever build the server happens to be serving. It means a real
    document from that origin reached DOM-ready and is running our JS, and it is
    the only signal allowed to decide recovery.
  - `window_ready` is raised by the APP, and means the page has painted
    something worth looking at rather than its boot screen. It is the nicer
    reveal and it carries the theme, but it may never decide whether the server
    is reachable.
  - That split is load-bearing, and was learned the hard way: recovery keyed on
    `window_ready` alone threw away a working session every six seconds against
    any deployment older than the shell — which is every deployment, briefly,
    since the shell and the hosted app ship independently. Anything the shell
    depends on for a window's fate has to come from the shell's own script.
  - Timing: `SHOW_GRACE` (350ms after DOM-ready) is the gap in which a current
    build's `window_ready` wins the race — it hydrates from `localStorage`
    synchronously, so it arrives within tens of ms — and is all an older build
    costs the user. `SHOW_DEADLINE` (1.2s) is the absolute backstop for a page
    that never reaches DOM-ready at all. `RECOVER_DEADLINE` (6s) is deliberately
    longer than the 5s `probe_server` timeout the bootstrap page allows, so
    nothing which used to load in time is now pulled out from under itself.
  - Recovery is a NAVIGATION to `tauri://localhost` rather than a new window, so
    it lands where the user was already looking. The constant is spelled out
    because Tauri's own resolution of `WebviewUrl::App` is not reachable once a
    window exists; it is what `tauri_protocol_url` returns on both Apple targets
    (Windows and Android get `http(s)://tauri.localhost`, and neither is a
    target here), and `config::is_allowed` admits the `tauri` scheme. If the
    navigation fails, desktop falls back to a real bootstrap window — built
    BEFORE the dead one is closed, since closing the last window would take the
    app with it.
  - A window is revealed ONCE, whichever signal gets there first. A reload
    raises both again, and re-revealing would raise a background window over
    whatever the user is now looking at.
  - What these mean once the service worker is in play IS the offline behaviour,
    not a hole in it: with the server unreachable the cached shell still loads,
    still runs the init script and still reports loaded, so the app opens
    read-only on cached state and recovery correctly never fires.
- `src/notify.rs` owns `notify` and the choice of backend. It collapses an
  identical alert repeated within three seconds: the server broadcasts one
  `appNotification` to every connected client, each open window is one, so
  without the collapse a second window means a second banner. Doing it here
  rather than electing a window in the page keeps it correct when that window is
  closed mid-alert.
- The Apple backend is hand-rolled rather than taken from
  `tauri-plugin-notification`, for the same reason on both platforms: the plugin
  cannot report where a tap should GO. Its desktop path shows the notification
  inside a spawned task and drops the handle, so the response is never observed;
  its iOS path strips a notification's `userInfo` out of the event it reports,
  so the target the alert was built with cannot be read back. The plugin is
  therefore a dependency of neither Apple target, which also keeps its Swift
  package out of the Xcode project — the iOS app has no SPM dependency at all.
  - macOS and iOS share ONE backend, `src/usernotify.rs`, because
    `UserNotifications` is the same framework on both down to the delegate
    method that reports a tap. Only what a GRANT unlocks differs — an APNs
    registration on iOS, nothing on macOS — so that is the single hook `setup`
    takes from its caller. Other desktops keep the plugin and have no click.
  - macOS used to take the deprecated `NSUserNotification` through
    `mac-notification-sys` instead, and that is worth recording because it
    looked fine and was not. The API reports a click but has no auto-dismiss
    callback, so the crate POLLED `deliveredNotifications` from a repeating 0.5s
    main-run-loop timer — one per notification — and blocked a thread until that
    poll resolved. A notification the user neither clicks nor clears stays in
    Notification Center indefinitely, so it never resolved: every ignored alert
    leaked its thread AND its timer, and each surviving timer became a permanent
    2 Hz SYNCHRONOUS XPC round-trip that re-serialised the whole delivered list.
    A day-old session measured 51 leaked threads, a main thread blocked 99% of
    the time, and ~50% of a CPU split between the app and `usernoted`, degrading
    quadratically as the list grew. `didReceiveNotificationResponse:` is a
    callback, so none of that machinery exists any more.
  - The macOS bundle must be CODE SIGNED or `UserNotifications` refuses
    everything: `requestAuthorization` fails with `UNErrorDomain` error 1
    (`NotificationsNotAllowed`) and no alert is ever shown. Tauri leaves a
    bundle merely linker-signed when no identity is configured, with the
    signature bound to neither the Info.plist nor the bundle identifier, which
    is not enough — so `bundle.macOS.signingIdentity` is `"-"` (ad-hoc) in
    `tauri.conf.json`. That is a floor, not a ceiling: `APPLE_SIGNING_IDENTITY`
    takes precedence over the config, so a real Developer ID build is
    unaffected.
- `src/openurl.rs` is the single door for an open request from OUTSIDE the page:
  a clicked notification, a `pa://` link opened anywhere on the machine, and a
  tapped iOS notification. They are one request in three costumes, so routing
  them separately is how they drift.
  - The target is a STRING the shell does not interpret, either a `pa://` URI or
    an app path. Teaching the shell the route table would mean rebuilding it
    whenever a route moves, which is what a remote-URL shell exists to avoid, so
    `app/web/src/lib/openTarget.ts` owns that half — and DROPS anything it does
    not recognise, since any program on the machine can hand the app a `pa://`
    URL.
  - It is addressed to ONE window (`emit_to`), not broadcast: with several open,
    a broadcast moves every one of them somewhere the user asked for once.
  - A target that arrives before any page is listening — the case that matters,
    since a `pa://` link LAUNCHES the app and the page then takes seconds to
    subscribe — is parked in a single slot and collected by the first page to
    ask. `PAGE_READY` is what tells the two apart.
- `src/usernotify.rs` owns the notification half both Apple platforms share,
  written against `UserNotifications` with `objc2`.
  - `PANotificationDelegate` implements both `UNUserNotificationCenterDelegate`
    methods. Without `willPresent`, the OS shows NOTHING while the app is in the
    foreground — which is most of the time a socket-delivered alert exists;
    without `didReceiveResponse`, a tap only activates the app and loses the
    session it was about. `setDelegate:` is a WEAK property, so the one delegate
    the process needs is deliberately leaked (the alternative is a static
    holding a `Retained`, which is not `Send`).
  - It is installed from Tauri's `setup`, which on iOS runs inside
    `didFinishLaunchingWithOptions:`. That timing is a requirement: a tap that
    LAUNCHED the app is delivered only if a delegate exists before launch
    finishes, and that is the tap most worth honouring.
  - `TARGET_KEY` (`paTarget`) is where a tap finds its destination. A local
    notification carries it in `userInfo`; an APNs payload carries it at the top
    level, beside `aps`, because `userInfo` for a remote notification IS the
    whole JSON body. One key, one tap handler, and neither delivery route knows
    the other exists. The server writes the same key (`app/server/src/apns.ts`).
  - Authorization is requested at launch rather than at the first alert: the
    prompt is once per install, and delaying it would delay the device token,
    and therefore push delivery, until the user opened a settings page. Until it
    answers, `notifications_allowed` is false — which is the honest answer, and
    what `push_registration` reports on both Apple platforms.
  - A notification identifier is `pa-<pid>-<n>`. A repeated identifier REPLACES
    the notification already showing, and the counter restarts at zero every
    launch, so without the pid a macOS shell left open for days would have each
    launch's first alert quietly replace the previous launch's unread one.
  - `is_bundled` guards the whole module: `currentNotificationCenter` raises an
    Objective-C exception when the main bundle has no identifier, and nothing
    catches that one. A `cargo tauri dev` binary is a bare executable under
    `target/`, so it has none and gets no alerts.
- `src/ios.rs` owns what is left that no other platform has, against `UIKit`.
  - APNs registration needs two `UIApplicationDelegate` callbacks that tao's
    runtime-built `AppDelegate` class does not have and offers no hook to add,
    so they are attached to the registered class with `class_addMethod`. Adding
    a METHOD to a live class is supported (an ivar is not), and UIKit only asks
    whether the delegate responds to them once a token is on its way.
  - `cover_safe_area` sets the webview's scroll view to
    `contentInsetAdjustmentBehavior = .never`. The default `.automatic` insets
    the web CONTENT by the safe area, so the page gets a 402x778 viewport on an
    874pt screen with undrawn bands top and bottom AND `env(safe-area-inset-*)`
    reading zero. The web build already pads its own chrome from those insets,
    for the installed Home Screen app, so it wants the full screen and honest
    values.
  - `log` routes `trace!` through `NSLog`. An iOS process has no stderr anyone
    can read — neither `simctl launch --console` nor
    `devicectl device process launch --console` relays it, and a phone has no
    terminal — while the unified log is visible through
    `xcrun simctl spawn <device> log stream` for the simulator and Console.app
    for a device. There is no CLI path for that second half: `log stream` takes
    no device, and libimobiledevice cannot see a modern iOS device at all. The
    message is passed as an ARGUMENT to `%@`, never as the format string: a
    session title can contain a `%`.
- `src/menu.rs` owns the menu bar, spelled out in full rather than extended from
  `Menu::default` (whose File and View submenus are built inline and cannot be
  reached afterwards to insert into). It carries the three shortcuts a
  remote-URL shell would otherwise lack — `Cmd-N` New Window, `Cmd-R` Reload,
  `Shift-Cmd-R` Force Reload — alongside the predefined items, plus `Server…`,
  which exists because the bootstrap page is no longer somewhere a window passes
  through: without a menu item there would be no way to reach it that is not a
  failure. It sits in the application submenu on macOS, where a setting for the
  whole app belongs, and in File on the other desktops, which have none. The
  Edit submenu is not decoration: without the predefined Cut/Copy/Paste items
  macOS routes no clipboard shortcut to the web view at all.
- Force Reload clears the origin's website data and then reloads, with a short
  gap between the two. WebKit removes data asynchronously and wry exposes no
  completion hook, so a reload issued in the same breath can be served from the
  cache it was meant to drop. The app's auth token is injected into the served
  HTML rather than stored in the page, so the wipe costs local preferences and
  caches and never the session.
- `tauri-plugin-deep-link` only reports a URL on Apple platforms
  (`RunEvent::Opened`, from tao's `application:openURL:options:` on iOS);
  registration is static, from the bundle's `CFBundleURLTypes`. Nothing is
  granted to the page: the shell subscribes in Rust and re-emits through
  `openurl`.
  - The plugin's `mobile` config exists here only to stop it working against us.
    Its build step rewrites the iOS project's `Info.plist`, and with `mobile`
    empty that means REMOVING `CFBundleURLTypes` — so `pa://` went unregistered
    on iOS while the key was present in our own `Info.plist`. Naming the scheme
    under `mobile` (no host, so it is a custom scheme rather than a universal
    link) leaves the key alone; the same branch also strips the
    `associated-domains` entitlement we do not want.
- `src/config.rs` owns `shell.json` in the app config dir and `is_allowed`, the
  navigation guard shared by the window and new-window handlers. Server choices
  extend the process-local trust set in `src/origins.rs` and the runtime IPC
  capability together. Three things share that file, so every setter goes load →
  change → store: one that serialized only its own field would silently drop the
  other two.
  - The server URL is validated on read as well as write. Invalid stored choices
    fall back to the build-time default; startup grants the chosen origin before
    any hosted window loads.
  - The theme and the window geometry are stored because the window is created
    before any page has run: neither can be asked for in time, so the page
    reports them through `window_ready` and the shell reads them back one launch
    later. Neither is authoritative — `assistant.prefs` on the served origin
    still owns the theme — they exist to avoid a flash and a jump.
  - Geometry is PHYSICAL px, the units `WindowEvent::Resized` and `Moved`
    report, so nothing is converted on the way in or out. It is applied after
    the build rather than through the builder, because `inner_size` is logical
    and converting would need the scale factor of a window that does not exist
    yet; the window is still hidden there, so there is nothing to see jump. A
    position is restored only if `monitor_from_point` still finds a screen under
    it, or an unplugged display would leave the window unreachable — and a
    fullscreen, maximized or minimized window is not recorded at all, since
    those are states one window is in rather than the size the next one should
    be.
  - Because every window is restored to the ONE remembered place,
    `cascade_clear_of_others` steps a new window forward until the spot is free;
    otherwise a second window would hide the first completely and look like
    nothing happened. It compares against the other windows rather than
    offsetting from whichever has focus, and that is what keeps it correct now
    that a new window is hidden and unfocused until its page reports: two
    `Cmd-N`s in quick succession see the SAME focused window, so a
    focus-relative offset would put both new windows in one place.
  - Writes are debounced (500ms) because a drag delivers an event per frame. The
    scheduling flag is claimed before the thread is spawned and the writer reads
    the newest value at the END of the wait, so a gesture is one write and its
    last frame is what lands.
  - `tauri-plugin-window-state` was not used: it keys state by window label, and
    labels here are `window1`, `window2` … and never reused, so its keying
    cannot match a window twice.
- `bootstrap/index.html` is the only bundled page, and it is now a RECOVERY
  surface rather than the way in: `ready`'s long deadline sends a window that
  never loaded back to it, and `Server…` opens it deliberately. It probes the
  configured server and — when the probe fails — offers a field to point
  somewhere else. It exists because navigation is one-way and a shell window has
  no back button to return from a raw WebKit error page. `probe_server` stays
  its own: a probe is useful when someone is choosing a server, and was only
  harmful when it gated a window that had a perfectly good cached copy to show.

## One socket per app instance: considered, declined

Asked whenever the multi-window shell comes up, so the answer is recorded rather
than re-derived. A Rust-side WebSocket shared by every window is available —
`tokio` and TLS are already in the tree through `reqwest`, so
`tokio-tungstenite` would be a small addition — but the cost is a protocol
change, not a Tauri feature, and the payoff is smaller than it looks.

The server does not treat a connection as a pipe. `Connection` implements the
full `Viewer` contract (`app/server/src/harness.ts`) and answers five
per-connection predicates — `wantsArchivedSessions`, `wantsTopic`,
`wantsSubagentThread`, `wantsComments`, `wantsWorktree` — while live sessions
keep their own viewer sets so token streams reach only the windows watching that
session. Per-window intent even rides the connect URL: `defaultSocketUrl` puts
`sessionId` and the IndexedDB timeline-cache descriptor in the query string.

There are two possible shapes and neither pays.

- **One `Connection` shared by all windows** — a broker in Rust — breaks
  semantics. `abort`, `prompt`, `setModel`, `runSlashCommand` and about six more
  carry no session id and act on the implicit `this.viewing`, referenced ~50
  times in `connection.ts`, so one window's abort would kill another's run.
  `view()` detaches the previous transport and releases every held subagent
  thread. A second `subscribe` for a topic already held returns nothing at all
  (`if (!fresh) continue`), so the second window renders empty forever.
  `unsubscribe` is not refcounted. And `saveTask`'s `linkCurrentSession` would
  link the OTHER window's session — durable data corruption rather than a
  rendering glitch.
- **One socket multiplexing a channel per window**, with the server building an
  ordinary `Connection` per channel, avoids every one of those. But the server
  then does the same per-window work anyway — session-list rebuild, settings
  read, timeline projection — so the entire saving is one TCP/TLS handshake and
  one token check, against new wire shapes in `app/shared/`, a channel-aware
  transport on the server, a socket owner here, and agent token streams
  re-serialised through Tauri's event bridge once per window.

What would genuinely want a socket in Rust is narrower and different: a
connection that exists when NO window does, which is the prerequisite for a Dock
badge, a menu bar item, and alerts while the app sits in the background. That
needs one channel and no multiplexing. It also needs `RunEvent` handling the
shell does not have yet — closing the last window currently quits the app — so
it is its own piece of work rather than a variation on this one.

## Server configuration and trust

The first-launch server is `http://localhost:8787`. Set `PA_SHELL_SERVER_URL`
when compiling to choose a different default, for example:

```sh
cd app/shell
PA_SHELL_SERVER_URL=https://assistant.example cargo tauri build
```

`build.rs` validates the compiled default and emits its normalized origin.
Invalid schemes, missing hosts, credentials, host patterns, non-loopback HTTP,
and paths, queries or fragments fail the build with an
`Invalid PA_SHELL_SERVER_URL` error. A trailing slash is accepted and removed.

The server chosen through the bootstrap page or `Server…` takes precedence and
is persisted in `shell.json` under the bundle identifier's app config directory.
Changing the build-time default does not overwrite that choice. Server choices
must be HTTPS URLs without credentials or host patterns. HTTP is accepted only
for loopback hosts, including `localhost` and loopback IP addresses. The shell
normalizes picker input to an origin, discarding paths, queries and fragments.

`src/origins.rs` owns the process-local set and generates the URLPatterns used
by both `config::is_allowed` and Tauri IPC. It starts empty. Each explicitly
chosen server adds its exact origin and preview origins with the same scheme and
port. Previews use `pr-([a-z0-9-]+).<host>`, requiring a non-empty suffix within
one label; `pr-.<host>` and `pr-1.evil.<host>` do not match. IP addresses and
`localhost` do not get preview patterns.

Loopback is not blanket-trusted. The default grants only
`http://localhost:8787`; a dev server on another port must be explicitly chosen.
In particular, server-side services exposed on loopback ports by port forwarding
do not gain native IPC. Other subdomains, ports and schemes are not implicitly
trusted. Opening a link or navigating a page never extends the set.

At startup, the shell grants the persisted server or the build-time default
before opening a hosted window. A bootstrap repoint first probes the candidate
server. Only a successful probe installs the runtime capability and navigation
patterns, before persisting or loading the new choice. Failed probes grant no
trust. Hosted pages never receive the server-repointing command. `remote.json`
grants only the app windows, not `popup*`, and has `local: false`; only the
bootstrap's `default` capability is statically enabled in `tauri.conf.json`.

The locked Tauri 2.11.5 supports `Manager::add_capability` but cannot revoke or
replace runtime grants. A previously chosen server therefore stays trusted until
the app restarts. Navigation retains exactly the same process-local patterns as
IPC. After restart only the current persisted server or compiled default, with
its previews, remains trusted. Runtime grants were chosen over generated
build-time origins so a user can repoint to another deployment without
rebuilding or losing native IPC. iOS cannot relaunch itself to replace grants.

## Packaging

The repository's bundle identifier is `com.example.personal-assistant`. Keep
per-deployment identity and signing settings outside tracked files, in the
ignored `app/shell/tauri.local.json`, for example:

```json
{
  "identifier": "org.example.assistant",
  "bundle": {
    "iOS": {
      "developmentTeam": "YOUR_TEAM_ID"
    }
  }
}
```

Pass the same merge config to desktop builds and every iOS init/build/dev
command. From `app/shell/`:

```sh
PA_SHELL_SERVER_URL=https://assistant.example cargo tauri build --config tauri.local.json
cargo tauri ios init --config tauri.local.json
PA_SHELL_SERVER_URL=https://assistant.example cargo tauri ios build --config tauri.local.json
APNS_ENVIRONMENT=production PA_SHELL_SERVER_URL=https://assistant.example cargo tauri ios build --config tauri.local.json
```

The last command is for an App Store or TestFlight distribution. Use the same
identifier as an existing installation to keep its config directory and server
choice. If an iOS project already exists under another identity, regenerate it
with `ios init` and the merge config rather than editing `gen/`.

Builds warn when the effective identifier still starts with `com.example.`. The
warning runs for release profiles and all Tauri CLI invocations, including debug
bundles and dev, since the build script cannot distinguish those CLI modes. The
target-specific config loader and the CLI's `TAURI_CONFIG` merge provide the
effective identifier, so a local override avoids the warning. Release profiles
also warn when `PA_SHELL_SERVER_URL` is unset. Both warnings are advisory; a
localhost release build is still allowed.

The merged Tauri identifier supplies `CFBundleIdentifier` and the generated iOS
project's bundle ID. `Info.plist` declares the shared `pa` URL scheme but has no
fixed `CFBundleURLName` to conflict with the deployment identity. Signing and
provisioning supply the iOS `application-identifier` entitlement from the
signing team and bundle ID; `build.rs` preserves those entitlements when adding
`aps-environment`. The APNs server's topic must equal this bundle ID, and its
credentials and provisioning profile must belong to the same app and team. A
local config changes no APNs server settings automatically.

Verify identity, capture, remote IPC, deep links and notification taps in a
bundled, signed macOS/iOS build on a remote origin. A Linux build or `tauri dev`
cannot verify those contracts.

- `Info.plist` is merged into the macOS bundle by the Tauri bundler and into the
  generated iOS project's `Info.plist` by `tauri ios build`/`dev`, so both
  platforms get one copy of these keys. `NSMicrophoneUsageDescription` is
  load-bearing rather than paperwork: WebKit hides `navigator.mediaDevices` from
  a WKWebView whose host app declares no purpose string, so without it the web
  app's own capability check reports "this browser does not expose microphone
  capture" and disables dictation before any permission is asked for.
- `entitlements.plist` adds `com.apple.security.device.audio-input`, which
  applies only to a code-signed macOS build. Tauri signs with the hardened
  runtime, and a hardened process is denied capture regardless of its purpose
  string without it — so dictation would break only in the distributed build.
- `cargo tauri dev` runs a bare binary with no `Info.plist` at all. Anything
  gated on bundle metadata (capture, notification identity) has to be verified
  in a bundled build.
- `target/` and `gen/` are generated output. Regenerate `icons/` from
  `app/web/public/icon.svg` with `cargo tauri icon`.

## iOS builds

- `cargo tauri ios init` generates `gen/apple` (an XcodeGen project). It needs
  `xcodegen`, `libimobiledevice` and a `pod` on `PATH` — `cargo-mobile2` checks
  for all three by binary name even though Tauri v2 uses Swift Package Manager
  and never runs CocoaPods. On a machine without Homebrew:
  `nix profile install nixpkgs#{xcodegen,libimobiledevice,cocoapods}`.
- `cargo tauri ios build --debug --target aarch64-sim` produces
  `gen/apple/build/arm64-sim/Pandeck.app` for `simctl install`. Remove
  `gen/apple/build` between runs: a leftover `.xcarchive` makes the CLI's final
  rename fail with `Directory not empty`.
- Set `bundle.iOS.developmentTeam` in the ignored merge config or export
  `APPLE_DEVELOPMENT_TEAM` for the signing team. The tracked config has no team.
  Only a device build needs one.
- `build.rs` also copies `icons/ios/` over the generated project's
  `AppIcon.appiconset`. The Xcode template pack fills that with the TAURI logo
  and never looks at `icons/`, so a fresh project ships someone else's mark on
  the Home Screen and on every notification. `cargo tauri icon` writes there
  too, but only once `gen/apple` exists and only when someone re-runs it; the
  copy makes it automatic. Regenerate `icons/ios/` itself with
  `cargo tauri icon` while no `gen/apple` is present, or it writes into the
  catalog instead.
- `build.rs` writes `aps-environment` into the generated project's entitlements
  and exports the same value as the `APNS_ENVIRONMENT` compile-time variable,
  which `push_registration` reports to the page. It is `development` unless
  `APNS_ENVIRONMENT=production` is set for a distribution build. Doing it in
  `build.rs` is what makes it survive `ios init` regenerating the file, and it
  is safe against the deep-link plugin editing the same file because a crate's
  build script runs only after every dependency of that crate is built.
- The simulator issues a device token and accepts `xcrun simctl push`, which is
  enough to verify the delegate, the payload and the banner. It is NOT a real
  APNs token, so delivery from the server can only be verified on a device.
