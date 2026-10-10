# Desktop port forwarding

The macOS shell can expose one TCP service running on the Pandeck server at the
same port on the laptop. A forward for port `N` listens only on `127.0.0.1:N`,
connects only to `127.0.0.1:N` on the server, and gives the user
`http://localhost:N` to open. Ports are restricted to 1024 through 65535. A bind
collision is an error. The shell never selects another port.

This is a byte transport, not an HTTP proxy. It carries HTTP response streaming,
WebSockets, HMR and non-HTTP TCP without inspecting them. Each accepted local
TCP connection gets a separate WSS connection to `/ws/port-forward`; it never
shares the JSON application socket. WebSocket messages are binary and
compression is disabled.

## Authentication and authority

The hosted app mints a grant with an authenticated
`POST /api/port-forward-grants`. A grant names exactly one port, expires after
24 hours, and exists only in server memory. Its random token is sent to the
native shell and then in the WSS `Authorization: Bearer` header. It never enters
a URL or log. The grant's non-secret id is enough for an authenticated caller to
revoke it.

A grant authorizes connections only to IPv4 server loopback at its named port.
The upgrade route accepts no host, destination port, query string or other
routing argument. A server restart invalidates every grant. Revocation or expiry
closes its active WSS connections.

The server permits at most 16 active grants, 16 connections per grant and 64
forwarded connections across the process. Frames are at most 64 KiB in each
direction; the server splits larger target reads. Each direction keeps one write
in flight. Target reads wait for the WebSocket send. Under Node, WebSocket reads
also wait for the target write. Bun's server socket cannot pause, so its frames
queue instead, copied into 64 KiB chunks. Empty frames are dropped, and a
connection with more than 4 MiB queued is closed with 1008. A text frame closes
with 1003 and an oversized frame with 1009, before any of their bytes reach the
target. When one side ends, what it already sent is still delivered to the other
before the connection closes. A target that refuses the connection, or has not
accepted it within 10 seconds, closes the WSS with 1011 and a reason naming the
port (`nothing is listening on port N there`), which the shell shows the user.

## Native boundary

Only the macOS shell can listen. `start_port_forward` derives the WSS origin
from the shell's validated server configuration and validates the port and grant
again. Hosted JavaScript cannot pass a server URL or destination host. Before
binding, the shell displays a native confirmation titled `Forward localhost:N?`
whose text names both ends (`127.0.0.1:N` on this Mac, and `127.0.0.1:N` on the
configured server, named as host and port) and whose buttons are Allow and
Cancel. The shell reserves the port before showing the dialog, serializes
confirmations, and permits at most 16 pending plus active forwards. A second
start for a reserved port fails without another dialog. A Cancel reaches the
page as a tagged `cancelled` rejection, distinct from a failure, and is never
reported as one. The listener lives exactly until the grant's server-side
expiry, capped at 24 hours locally; the clock-skew allowance applies only to
judging whether a grant is plausible. Native accepted connections are also
capped independently at 16 per forward and 64 across the app.

The hosted app receives only four commands: start, list, stop and open. It
receives no generic socket, shell, browser or dialog capability. `open` takes
one URL and hands it to the OS default browser, never to a shell window, and
only after validating it in the shell: explicit `http` or `https`, a host of
`localhost`, `127.0.0.1` or `[::1]`, no credentials, and an explicit port in
range that this shell is forwarding right now. The host is rewritten to
`localhost`; scheme, port, path, query and fragment are opened as written.
Changing the configured server stops every listener. Grant expiry and an
explicit stop also close the listener and its accepted streams. The web helper
revokes the server grant on an explicit stop, after the listener is down; if
that revocation fails the forward is still stopped, the page says so naming the
port, and the grant is left to its own expiry, which is bounded and useless
without the token that left memory with the listener. Process exit lets the OS
close all remaining listeners and streams.

The shell reports public tunnel state only: port, localhost URL, configured
server origin, expiry, active connection count and last failure. It does not
return the grant token from list operations.

## Failed connections

The browser sees a connection the server did not carry only as a reset, so the
shell says what happened. A connection fails when its WSS handshake does not
complete (a timeout, an unreachable or untrusted server, or a refused upgrade,
worded by HTTP status), when the server closes it with any code but 1000 (its
reason is shown), or when forwarding it panics in the shell. A carried stream
that later breaks is how many connections end, and is not reported. The
forward's `lastFailure` holds the most recent failure's message and time until
the server carries a connection again, meaning it sends the first byte back. A
failure also raises a native notification, `Port forward failed`, naming
`localhost:N`, that opens Settings → Port forwarding: once per streak (the first
failure since the forward last carried a connection, or a different failure),
and never more than one per 30 seconds per forward, since a browser opens
connections in bursts. With notifications turned off the failure is still on the
forward's row. iOS and other desktop builds expose no forwarding implementation
and continue to use the same shared shell crate.

## Settings

Settings → Developer workflow → Port forwarding is one form and one list. The
form takes the server port alone, because the mapping is same-port by design,
and refuses anything outside 1024 through 65535, or a port already listed as
forwarded, before a grant is minted. A failed start is shown on the form; the
user's own Cancel shows nothing and keeps the typed port. A failed open or stop
is shown on its row while the row exists, and announced naming the port once the
row is gone; a row's error is dropped when the shell stops listing that port.
Open and Stop on one row are independent, each busy on its own. The list shows
each forward's localhost URL, the configured server it connects to, its active
connection count and its expiry (`expired` once passed), with Open (the OS
browser, through the validated command) and Stop (which also revokes the grant).
A forward with a `lastFailure` shows it on its row, with how long ago it
happened. While the page is visible the list is re-read from the shell every few
seconds and on return to the tab; hidden or unmounted, it reads nothing.

The section is routable on every client, so a shared link lands on a page that
says it needs the macOS app. It is listed in the settings navigation only in the
macOS shell (`settingsSections.tsx`, `shownWhen`).

## Links in content

In the macOS shell, when the app itself is served from a non-loopback origin, a
plain primary click on a Markdown link written as an explicit `http` or `https`
URL to `localhost`, `127.0.0.1` or `[::1]` with an explicit port in range is
forwarded instead of opened as written: if that port is already forwarded the
rewritten `localhost` URL opens in the OS browser; otherwise a grant is minted,
the shell's native confirmation runs, and the URL opens once the listener is up.
Path, query and fragment are preserved. A modified click, any other link shape,
a browser, iOS, and an app served from loopback keep the anchor's ordinary
behaviour, and the anchor's `href` is never rewritten. A failure is a toast
naming `localhost:PORT`; a cancelled confirmation is silent. Starts are
de-duplicated per port in the page (`lib/portForwards.ts`), so a repeat click or
a Settings start for the same port joins the one in flight rather than raising a
second confirmation.
