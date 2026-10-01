use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const MIN_PORT: u16 = 1024;
const MAX_GRANT_LIFETIME_MS: u64 = 24 * 60 * 60_000;
const GRANT_CLOCK_SKEW_MS: u64 = 5 * 60_000;
const MAX_TUNNELS: usize = 16;
const MAX_CONNECTIONS: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardGrant {
    id: String,
    token: String,
    port: u16,
    expires_at: String,
    expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardStatus {
    port: u16,
    local_url: String,
    server_origin: String,
    active_connections: usize,
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoppedPortForward {
    grant_id: String,
}

/// Why a start did not produce a listener. The user's own Cancel in the native
/// consent dialog is its own variant so the page can stay silent about it
/// rather than pattern-match a message; everything else carries its text.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PortForwardStartError {
    Cancelled,
    Failed { message: String },
}

impl From<String> for PortForwardStartError {
    fn from(message: String) -> Self {
        PortForwardStartError::Failed { message }
    }
}

/// The loopback hosts a link may name, as `Url::host_str` reports them.
#[cfg(any(target_os = "macos", test))]
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// The one URL shape the hosted page may hand to the OS browser through
/// `open_port_forward_url`: explicit `http`/`https`, a loopback host, no
/// credentials, and an explicit port that `is_active` confirms is a forward
/// this shell is running. Anything else is refused, so the command cannot be
/// used as a general-purpose opener. The host is rewritten to `localhost`;
/// scheme, port, path, query and fragment are kept as written.
#[cfg(any(target_os = "macos", test))]
fn forwarded_local_url(raw: &str, is_active: impl Fn(u16) -> bool) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(raw).map_err(|_| "Not a valid localhost URL.".to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !url
            .host_str()
            .is_some_and(|host| LOOPBACK_HOSTS.contains(&host))
    {
        return Err("Not a forwardable localhost URL.".to_string());
    }
    let Some(port) = url.port() else {
        return Err("The localhost URL names no port.".to_string());
    };
    if port < MIN_PORT {
        return Err(format!("Port must be from {MIN_PORT} through 65535."));
    }
    if !is_active(port) {
        return Err(format!("No forward for localhost:{port} is running."));
    }
    url.set_host(Some("localhost"))
        .map_err(|_| "Not a forwardable localhost URL.".to_string())?;
    Ok(url)
}

fn valid_opaque(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_grant_at(grant: &PortForwardGrant, now_ms: u64) -> Result<Duration, String> {
    if grant.port < MIN_PORT {
        return Err(format!("Port must be from {MIN_PORT} through 65535."));
    }
    if !valid_opaque(&grant.id, 12, 64) || !valid_opaque(&grant.token, 32, 128) {
        return Err("The server returned an invalid port-forward grant.".to_string());
    }
    if grant.expires_at.len() < 20
        || grant.expires_at.len() > 40
        || !grant.expires_at.ends_with('Z')
        || !grant.expires_at.is_ascii()
    {
        return Err("The server returned an invalid grant expiry.".to_string());
    }
    if grant.expires_at_ms <= now_ms
        || grant.expires_at_ms
            > now_ms
                .saturating_add(MAX_GRANT_LIFETIME_MS)
                .saturating_add(GRANT_CLOCK_SKEW_MS)
    {
        return Err("The port-forward grant is expired or has an invalid lifetime.".to_string());
    }
    // The skew above only decides whether the grant is plausible; the listener
    // itself lives exactly as long as the server says, so the page's expiry and
    // the moment the port closes agree.
    Ok(Duration::from_millis(
        grant
            .expires_at_ms
            .saturating_sub(now_ms)
            .max(1)
            .min(MAX_GRANT_LIFETIME_MS),
    ))
}

fn validate_grant(grant: &PortForwardGrant) -> Result<Duration, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is invalid.".to_string())?
        .as_millis() as u64;
    validate_grant_at(grant, now_ms)
}

#[derive(Clone, Copy)]
struct AuthoritySlot {
    generation: u64,
    active: bool,
}

#[derive(Default)]
struct NativeAuthority {
    slots: std::collections::HashMap<u16, AuthoritySlot>,
    next_generation: u64,
}

#[cfg(any(target_os = "macos", test))]
async fn await_or_stop<T>(
    stop: &mut tokio::sync::watch::Receiver<bool>,
    operation: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        _ = stop.changed() => None,
        result = operation => Some(result),
    }
}

impl NativeAuthority {
    fn reserve(&mut self, port: u16) -> Result<u64, String> {
        if self.slots.contains_key(&port) {
            return Err(format!(
                "A forward for localhost:{port} is already pending or running."
            ));
        }
        if self.slots.len() >= MAX_TUNNELS {
            return Err(format!(
                "At most {MAX_TUNNELS} port forwards may be pending or running."
            ));
        }
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .ok_or_else(|| "The port-forward generation counter is exhausted.".to_string())?;
        let generation = self.next_generation;
        self.slots.insert(
            port,
            AuthoritySlot {
                generation,
                active: false,
            },
        );
        Ok(generation)
    }

    fn activate(&mut self, port: u16, generation: u64) -> bool {
        let Some(slot) = self.slots.get_mut(&port) else {
            return false;
        };
        if slot.generation != generation || slot.active {
            return false;
        }
        slot.active = true;
        true
    }

    fn release(&mut self, port: u16, generation: u64) -> bool {
        if self
            .slots
            .get(&port)
            .is_some_and(|slot| slot.generation == generation)
        {
            self.slots.remove(&port);
            true
        } else {
            false
        }
    }

    fn owns(&self, port: u16, generation: u64) -> bool {
        self.slots
            .get(&port)
            .is_some_and(|slot| slot.generation == generation)
    }

    fn active_generation(&self, port: u16) -> Option<u64> {
        self.slots
            .get(&port)
            .filter(|slot| slot.active)
            .map(|slot| slot.generation)
    }

    fn is_active(&self, port: u16) -> bool {
        self.active_generation(port).is_some()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use futures_util::{SinkExt, StreamExt};
    use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{watch, Mutex as AsyncMutex, Semaphore};
    use tokio::time::Instant;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, ORIGIN};
    use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
    use tokio_tungstenite::tungstenite::Message;

    use super::{
        await_or_stop, validate_grant, Duration, NativeAuthority, PortForwardGrant,
        PortForwardStartError, PortForwardStatus, StoppedPortForward, MAX_CONNECTIONS, MIN_PORT,
    };
    use crate::config;

    const MAX_CONNECTIONS_PER_TUNNEL: usize = 16;
    const FRAME_BYTES: usize = 32 * 1024;
    const FORWARD_PATH: &str = "/ws/port-forward";

    struct Tunnel {
        grant_id: String,
        status: PortForwardStatus,
        active: Arc<AtomicUsize>,
        stop: watch::Sender<bool>,
    }

    #[derive(Default)]
    struct ManagerInner {
        authority: NativeAuthority,
        tunnels: HashMap<u16, Tunnel>,
    }

    #[derive(Clone)]
    pub struct PortForwardManager {
        inner: Arc<Mutex<ManagerInner>>,
        confirmation: Arc<AsyncMutex<()>>,
        connections: Arc<Semaphore>,
    }

    impl Default for PortForwardManager {
        fn default() -> Self {
            Self {
                inner: Arc::new(Mutex::new(ManagerInner::default())),
                confirmation: Arc::new(AsyncMutex::new(())),
                connections: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            }
        }
    }

    struct StartReservation {
        manager: PortForwardManager,
        port: u16,
        generation: u64,
        committed: bool,
    }

    impl StartReservation {
        fn is_current(&self) -> bool {
            self.manager
                .inner
                .lock()
                .map(|inner| inner.authority.owns(self.port, self.generation))
                .unwrap_or(false)
        }

        fn commit(mut self, tunnel: Tunnel) -> Result<(), String> {
            let mut inner = self
                .manager
                .inner
                .lock()
                .map_err(|_| "Port-forward manager is unavailable.".to_string())?;
            if !inner.authority.activate(self.port, self.generation) {
                return Err("The port-forward request is no longer active.".to_string());
            }
            inner.tunnels.insert(self.port, tunnel);
            self.committed = true;
            Ok(())
        }
    }

    impl Drop for StartReservation {
        fn drop(&mut self) {
            if self.committed {
                return;
            }
            if let Ok(mut inner) = self.manager.inner.lock() {
                inner.authority.release(self.port, self.generation);
            }
        }
    }

    impl PortForwardManager {
        fn reserve(&self, port: u16) -> Result<StartReservation, String> {
            let generation = self
                .inner
                .lock()
                .map_err(|_| "Port-forward manager is unavailable.".to_string())?
                .authority
                .reserve(port)?;
            Ok(StartReservation {
                manager: self.clone(),
                port,
                generation,
                committed: false,
            })
        }

        fn remove_generation(&self, port: u16, generation: u64) -> Option<Tunnel> {
            let mut inner = self.inner.lock().ok()?;
            if !inner.authority.release(port, generation) {
                return None;
            }
            inner.tunnels.remove(&port)
        }

        fn remove_active(&self, port: u16) -> Option<Tunnel> {
            let mut inner = self.inner.lock().ok()?;
            let generation = inner.authority.active_generation(port)?;
            if !inner.authority.release(port, generation) {
                return None;
            }
            inner.tunnels.remove(&port)
        }

        /// Whether a listener for `port` is running right now.
        pub fn is_active(&self, port: u16) -> bool {
            self.inner
                .lock()
                .map(|inner| inner.authority.is_active(port))
                .unwrap_or(false)
        }

        pub fn stop_all(&self) {
            let tunnels = self
                .inner
                .lock()
                .map(|mut inner| {
                    inner.authority.slots.clear();
                    inner
                        .tunnels
                        .drain()
                        .map(|(_, tunnel)| tunnel)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for tunnel in tunnels {
                let _ = tunnel.stop.send(true);
            }
        }
    }

    /// What the consent dialog names as the far end: the configured server's
    /// host and port, the port made explicit even when it is the scheme default.
    struct ServerTarget {
        origin: String,
        websocket_url: String,
        host_and_port: String,
    }

    fn forwarding_urls(app: &AppHandle) -> Result<ServerTarget, String> {
        let raw = config::server_url(app);
        let parsed = tauri::Url::parse(&raw)
            .map_err(|_| "The configured server URL is invalid.".to_string())?;
        if !config::is_allowed(&parsed)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("The configured server URL cannot be used for forwarding.".to_string());
        }
        let mut websocket = parsed.clone();
        websocket
            .set_scheme(if parsed.scheme() == "https" {
                "wss"
            } else {
                "ws"
            })
            .map_err(|_| "The configured server scheme cannot be forwarded.".to_string())?;
        websocket.set_path(FORWARD_PATH);
        let host = parsed
            .host_str()
            .ok_or_else(|| "The configured server URL has no host.".to_string())?;
        let port = parsed
            .port_or_known_default()
            .ok_or_else(|| "The configured server URL has no port.".to_string())?;
        Ok(ServerTarget {
            origin: parsed.origin().ascii_serialization(),
            websocket_url: websocket.to_string(),
            host_and_port: format!("{host}:{port}"),
        })
    }

    const ALLOW_LABEL: &str = "Allow";
    const CANCEL_LABEL: &str = "Cancel";

    pub async fn start(
        app: AppHandle,
        manager: PortForwardManager,
        grant: PortForwardGrant,
    ) -> Result<PortForwardStatus, PortForwardStartError> {
        validate_grant(&grant)?;
        let server = forwarding_urls(&app)?;
        let server_origin = server.origin;
        let websocket_url = server.websocket_url;
        // Reserve authority before awaiting the dialog. This rejects duplicate
        // ports and caps forged concurrent invocations without opening native UI.
        let reservation = manager.reserve(grant.port)?;
        let _confirmation = manager.confirmation.lock().await;
        validate_grant(&grant)?;
        if !reservation.is_current() {
            return Err("The port-forward request was cancelled.".to_string().into());
        }

        // Consent names both ends and what the buttons do: the user is about
        // to open a port on THIS machine on behalf of a remote page.
        let confirmed = AsyncMessageDialog::new()
            .set_level(MessageLevel::Warning)
            .set_title(format!("Forward localhost:{}?", grant.port))
            .set_description(format!(
                "Pandeck will listen on this Mac at 127.0.0.1:{port} and forward every connection to 127.0.0.1:{port} on the server at {server}.\n\nThe forward stops when you stop it, when it expires, or when the app quits.",
                port = grant.port,
                server = server.host_and_port,
            ))
            .set_buttons(MessageButtons::OkCancelCustom(
                ALLOW_LABEL.to_string(),
                CANCEL_LABEL.to_string(),
            ))
            .show()
            .await;
        if !matches!(confirmed, MessageDialogResult::Custom(ref label) if label == ALLOW_LABEL) {
            return Err(PortForwardStartError::Cancelled);
        }
        if !reservation.is_current() {
            return Err("The port-forward request was cancelled.".to_string().into());
        }
        // Convert the ABSOLUTE server expiry to a monotonic deadline only after
        // all queue and consent time has elapsed. Binding then consumes this
        // same deadline rather than starting a fresh relative lifetime.
        let grant_expiry = Instant::now() + validate_grant(&grant)?;
        let listener = TcpListener::bind(("127.0.0.1", grant.port))
            .await
            .map_err(|err| format!("Could not listen on 127.0.0.1:{}: {err}", grant.port))?;
        // A grant can expire while bind is pending. Refuse activation and drop
        // the listener instead of briefly exposing an already-expired forward.
        validate_grant(&grant)?;
        let (stop_tx, stop_rx) = watch::channel(false);
        let active = Arc::new(AtomicUsize::new(0));
        let status = PortForwardStatus {
            port: grant.port,
            local_url: format!("http://localhost:{}", grant.port),
            server_origin: server_origin.clone(),
            active_connections: 0,
            expires_at: grant.expires_at.clone(),
        };
        let generation = reservation.generation;
        reservation.commit(Tunnel {
            grant_id: grant.id,
            status: status.clone(),
            active: active.clone(),
            stop: stop_tx,
        })?;

        let task_manager = manager.clone();
        let global_connections = manager.connections.clone();
        let port = grant.port;
        tauri::async_runtime::spawn(async move {
            accept_loop(
                listener,
                websocket_url,
                server_origin,
                grant.token,
                active,
                stop_rx,
                grant_expiry,
                global_connections,
            )
            .await;
            if let Some(tunnel) = task_manager.remove_generation(port, generation) {
                let _ = tunnel.stop.send(true);
            }
        });
        Ok(status)
    }

    async fn accept_loop(
        listener: TcpListener,
        websocket_url: String,
        server_origin: String,
        grant_token: String,
        active: Arc<AtomicUsize>,
        mut stop: watch::Receiver<bool>,
        grant_expiry: Instant,
        global_connections: Arc<Semaphore>,
    ) {
        let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS_PER_TUNNEL));
        let expiry = tokio::time::sleep_until(grant_expiry);
        tokio::pin!(expiry);
        loop {
            tokio::select! {
                _ = stop.changed() => return,
                _ = &mut expiry => return,
                accepted = listener.accept() => {
                    let Ok((tcp, _peer)) = accepted else { return };
                    let Ok(tunnel_slot) = slots.clone().try_acquire_owned() else {
                        drop(tcp);
                        continue;
                    };
                    let Ok(global_slot) = global_connections.clone().try_acquire_owned() else {
                        drop(tunnel_slot);
                        drop(tcp);
                        continue;
                    };
                    let websocket_url = websocket_url.clone();
                    let server_origin = server_origin.clone();
                    let grant_token = grant_token.clone();
                    let active = active.clone();
                    let connection_stop = stop.clone();
                    active.fetch_add(1, Ordering::Relaxed);
                    tauri::async_runtime::spawn(async move {
                        let _tunnel_slot = tunnel_slot;
                        let _global_slot = global_slot;
                        let _active = ActiveConnection(active);
                        let _ = bridge(
                            tcp,
                            &websocket_url,
                            &server_origin,
                            &grant_token,
                            connection_stop,
                        )
                        .await;
                    });
                }
            }
        }
    }

    struct ActiveConnection(Arc<AtomicUsize>);

    impl Drop for ActiveConnection {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::Relaxed);
        }
    }

    async fn bridge(
        mut tcp: TcpStream,
        websocket_url: &str,
        server_origin: &str,
        grant_token: &str,
        mut stop: watch::Receiver<bool>,
    ) -> Result<(), String> {
        tcp.set_nodelay(true).map_err(|err| err.to_string())?;
        let mut request = websocket_url
            .into_client_request()
            .map_err(|err| format!("Invalid forwarding socket URL: {err}"))?;
        request.headers_mut().insert(
            AUTHORIZATION,
            format!("Bearer {grant_token}")
                .parse()
                .map_err(|_| "Invalid forwarding grant.".to_string())?,
        );
        request.headers_mut().insert(
            ORIGIN,
            server_origin
                .parse()
                .map_err(|_| "Invalid configured server origin.".to_string())?,
        );
        let websocket_config = WebSocketConfig::default()
            .write_buffer_size(FRAME_BYTES)
            .max_write_buffer_size(FRAME_BYTES * 8)
            .max_message_size(Some(FRAME_BYTES * 2))
            .max_frame_size(Some(FRAME_BYTES * 2));
        let connecting =
            tokio_tungstenite::connect_async_with_config(request, Some(websocket_config), true);
        let (websocket, _) = tokio::select! {
            _ = stop.changed() => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(10), connecting) => result
                .map_err(|_| "The forwarding socket connection timed out.".to_string())?
                .map_err(|err| format!("Could not connect to the forwarding socket: {err}"))?,
        };
        let (mut websocket_write, mut websocket_read) = websocket.split();
        let mut buffer = vec![0_u8; FRAME_BYTES];

        loop {
            tokio::select! {
                _ = stop.changed() => return Ok(()),
                read = tcp.read(&mut buffer) => {
                    let read = read.map_err(|err| err.to_string())?;
                    if read == 0 {
                        let _ = await_or_stop(&mut stop, websocket_write.close()).await;
                        return Ok(());
                    }
                    let sending = websocket_write
                        .send(Message::Binary(buffer[..read].to_vec().into()));
                    let Some(result) = await_or_stop(&mut stop, sending).await else {
                        return Ok(());
                    };
                    result.map_err(|err| err.to_string())?;
                }
                message = websocket_read.next() => {
                    match message {
                        Some(Ok(Message::Binary(bytes))) => {
                            let Some(result) = await_or_stop(&mut stop, tcp.write_all(&bytes)).await else {
                                return Ok(());
                            };
                            result.map_err(|err| err.to_string())?;
                        },
                        Some(Ok(Message::Close(_))) | None => return Ok(()),
                        Some(Ok(Message::Ping(payload))) => {
                            let pong = websocket_write.send(Message::Pong(payload));
                            let Some(result) = await_or_stop(&mut stop, pong).await else {
                                return Ok(());
                            };
                            result.map_err(|err| err.to_string())?;
                        },
                        Some(Ok(Message::Pong(_))) => {},
                        Some(Ok(_)) => return Err("The forwarding socket sent non-binary data.".to_string()),
                        Some(Err(err)) => return Err(err.to_string()),
                    }
                }
            }
        }
    }

    pub fn list(manager: &PortForwardManager) -> Result<Vec<PortForwardStatus>, String> {
        let inner = manager
            .inner
            .lock()
            .map_err(|_| "Port-forward manager is unavailable.".to_string())?;
        let mut statuses = inner
            .tunnels
            .values()
            .map(|tunnel| {
                let mut status = tunnel.status.clone();
                status.active_connections = tunnel.active.load(Ordering::Relaxed);
                status
            })
            .collect::<Vec<_>>();
        statuses.sort_by_key(|status| status.port);
        Ok(statuses)
    }

    pub fn stop(manager: &PortForwardManager, port: u16) -> Result<StoppedPortForward, String> {
        if port < MIN_PORT {
            return Err(format!("Port must be from {MIN_PORT} through 65535."));
        }
        let tunnel = manager
            .remove_active(port)
            .ok_or_else(|| format!("No forward for localhost:{port} is running."))?;
        let _ = tunnel.stop.send(true);
        Ok(StoppedPortForward {
            grant_id: tunnel.grant_id,
        })
    }
}

#[cfg(target_os = "macos")]
pub use platform::PortForwardManager;

#[cfg(not(target_os = "macos"))]
#[derive(Clone, Default)]
pub struct PortForwardManager;

#[cfg(not(target_os = "macos"))]
impl PortForwardManager {
    pub fn stop_all(&self) {}
}

pub async fn start(
    app: AppHandle,
    manager: PortForwardManager,
    grant: PortForwardGrant,
) -> Result<PortForwardStatus, PortForwardStartError> {
    #[cfg(target_os = "macos")]
    return platform::start(app, manager, grant).await;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, manager, grant);
        Err("Port forwarding requires the macOS native shell."
            .to_string()
            .into())
    }
}

pub fn list(manager: &PortForwardManager) -> Result<Vec<PortForwardStatus>, String> {
    #[cfg(target_os = "macos")]
    return platform::list(manager);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = manager;
        Ok(Vec::new())
    }
}

pub fn stop(manager: &PortForwardManager, port: u16) -> Result<StoppedPortForward, String> {
    #[cfg(target_os = "macos")]
    return platform::stop(manager, port);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (manager, port);
        Err("Port forwarding requires the macOS native shell.".to_string())
    }
}

/// Open one active forward's localhost URL in the OS default browser.
pub fn open_url(app: &AppHandle, manager: &PortForwardManager, url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        let url = forwarded_local_url(url, |port| manager.is_active(port))?;
        app.opener()
            .open_url(url.to_string(), None::<&str>)
            .map_err(|err| format!("Could not open the forwarded URL: {err}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, manager, url);
        Err("Port forwarding requires the macOS native shell.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::{
        await_or_stop, forwarded_local_url, validate_grant, validate_grant_at, NativeAuthority,
        PortForwardGrant, GRANT_CLOCK_SKEW_MS, MAX_GRANT_LIFETIME_MS, MAX_TUNNELS, MIN_PORT,
    };

    #[test]
    fn opens_only_explicit_loopback_urls_on_active_forwards() {
        let active = |port: u16| port == 8080;
        for raw in [
            "http://localhost:8080",
            "http://127.0.0.1:8080/app?x=1#frag",
            "https://[::1]:8080/",
            "http://LOCALHOST:8080/",
        ] {
            assert!(forwarded_local_url(raw, active).is_ok(), "{raw}");
        }
        let rewritten = forwarded_local_url("http://127.0.0.1:8080/app?x=1#frag", active).unwrap();
        assert_eq!(rewritten.as_str(), "http://localhost:8080/app?x=1#frag");
        for raw in [
            "http://localhost:8081/",
            "http://localhost/",
            "http://localhost:80/",
            "http://localhost:1000/",
            "ftp://localhost:8080/",
            "file:///etc/passwd",
            "http://pa.example:8080/",
            "http://localhost.example:8080/",
            "http://user:pw@localhost:8080/",
            "/relative",
            "javascript:alert(1)",
        ] {
            assert!(forwarded_local_url(raw, active).is_err(), "{raw}");
        }
    }

    #[test]
    fn listener_lifetime_is_the_grant_expiry_without_skew() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let grant: PortForwardGrant = serde_json::from_value(serde_json::json!({
            "id": "grant_123456",
            "token": "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789",
            "port": MIN_PORT,
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "expiresAtMs": now_ms + 60_000
        }))
        .unwrap();
        let lifetime = validate_grant(&grant).unwrap().as_millis() as u64;
        assert!(lifetime <= 60_000 && lifetime > 55_000, "{lifetime}");
        let cancelled = serde_json::to_value(super::PortForwardStartError::Cancelled).unwrap();
        assert_eq!(cancelled, serde_json::json!({ "kind": "cancelled" }));
    }

    #[tokio::test]
    async fn stalled_backpressure_wait_is_cancelled() {
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let cancel = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            stop.send(true).unwrap();
        });
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            await_or_stop(&mut stopped, std::future::pending::<()>()),
        )
        .await
        .expect("cancellation must not wait for the stalled operation");
        cancel.await.unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn native_authority_bounds_pending_and_active_tunnels() {
        let mut authority = NativeAuthority::default();
        let first = authority.reserve(2000).unwrap();
        assert!(authority.reserve(2000).is_err());
        assert!(authority.activate(2000, first));
        for offset in 1..MAX_TUNNELS {
            authority.reserve(2000 + offset as u16).unwrap();
        }
        assert!(authority.reserve(3000).is_err());
    }

    #[test]
    fn stale_cleanup_cannot_release_a_new_generation() {
        let mut authority = NativeAuthority::default();
        let old = authority.reserve(8080).unwrap();
        assert!(authority.activate(8080, old));
        assert!(authority.release(8080, old));
        let new = authority.reserve(8080).unwrap();
        assert_ne!(old, new);
        assert!(!authority.release(8080, old));
        assert!(authority.owns(8080, new));
    }

    #[test]
    fn queued_and_confirmation_time_is_subtracted_from_absolute_expiry() {
        let issued_at = 1_000_000;
        let grant: PortForwardGrant = serde_json::from_value(serde_json::json!({
            "id": "grant_123456",
            "token": "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789",
            "port": MIN_PORT,
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "expiresAtMs": issued_at + 60_000
        }))
        .unwrap();
        assert_eq!(
            validate_grant_at(&grant, issued_at).unwrap(),
            Duration::from_secs(60)
        );
        assert_eq!(
            validate_grant_at(&grant, issued_at + 45_000).unwrap(),
            Duration::from_secs(15)
        );
        assert!(validate_grant_at(&grant, issued_at + 60_000).is_err());
    }

    #[test]
    fn listener_lifetime_never_exceeds_the_native_ceiling() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let grant: PortForwardGrant = serde_json::from_value(serde_json::json!({
            "id": "grant_123456",
            "token": "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789",
            "port": MIN_PORT,
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "expiresAtMs": now_ms + MAX_GRANT_LIFETIME_MS + GRANT_CLOCK_SKEW_MS
        }))
        .unwrap();
        assert_eq!(
            validate_grant(&grant).unwrap(),
            Duration::from_millis(MAX_GRANT_LIFETIME_MS)
        );
    }

    #[test]
    fn validates_the_untrusted_grant_shape_port_and_lifetime() {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let mut grant: PortForwardGrant = serde_json::from_value(serde_json::json!({
            "id": "grant_123456",
            "token": "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789",
            "port": MIN_PORT,
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "expiresAtMs": now_ms + 60_000
        }))
        .unwrap();
        assert!(validate_grant(&grant).is_ok());

        grant.port = MIN_PORT - 1;
        assert!(validate_grant(&grant).is_err());
        assert!(
            serde_json::from_value::<PortForwardGrant>(serde_json::json!({
                "id": "grant_123456",
                "token": "abcdefghijklmnopqrstuvwxyzABCDEFG_123456789",
                "port": 65536,
                "expiresAt": "2030-01-01T00:00:00.000Z",
                "expiresAtMs": now_ms + 60_000
            }))
            .is_err()
        );
    }
}
