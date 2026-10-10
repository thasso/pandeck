# Served files

How a file on this host reaches the user: in a chat card, in the in-app viewer,
or in a real browser tab. This document is the contract for the URL shapes, the
delivery rules, and the one place agent-authored HTML is allowed to run.

Before this, an agent could only show a file by COPYING it into
`DATA_DIR/session-artifacts/<session>/`, which cost a tool call, duplicated the
bytes, and left the copy behind. Session artifacts still exist for bytes a tool
captures (browser screenshots, retained tool output). They are no longer how an
agent shows a file it already wrote.

## The URL families

| URL                                                 | Authenticated by                | Serves                                                           |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `/api/files/<absolute path>`                        | app token (header or `?token=`) | Raw bytes of any file on the host, streamed, with range support  |
| `/api/file-grants/<grant id>/<relative path>`       | the grant id itself             | One file, or one sandboxed HTML directory when siblings must run |
| `/api/session-artifacts/<session>/<path>`           | app token                       | Bytes a tool captured into `DATA_DIR` (unchanged)                |
| `/api/session-attachment/<session>/<attachment id>` | app token                       | One IMAGE from the session's prompt attachment store             |

`/api/files/` puts the absolute path IN the route path rather than in a query
parameter, so a relative reference inside a served document (`./diagram.png` in
Markdown, `./chart.js` in HTML) resolves to the right file with no rewriting.
`?meta=1` answers JSON metadata instead of bytes; `?download=1` forces an
attachment; `?name=` renames the download.

The attachment route exists because a saved prompt's image is kept in the
durable log by attachment id only, so after a reload the chat has no other way
to show it. It answers only when the recorded MIME type is a plain `image/*`,
always with `x-content-type-options: nosniff`, and adds
`Content-Security-Policy: sandbox` for SVG; any other attachment is a 404, never
a download (`app/server/src/sessionAttachmentHttp.ts`).

## No path allow-list

There is none, deliberately. An agent can already read whatever the service can
read, so restricting where a LINK may point would not restrict what an agent may
see, and the check would only make a legitimate link fail. The token gate on
`/api/*` is the access control, and the app is meant to be reachable only on a
private network (see `deployment.md#host-and-data`).

What that leaves this code owning is DELIVERY, and the rules below are not
optional: without them the token in `?token=` is one `location.search` read away
from any document the app serves, and that token drives a Workshop session whose
Bash tool is arbitrary code execution.

## Delivery rules

Classification and inline MIME behavior live in `app/shared/servedFiles.ts` —
ONE mapping both halves read, because the server's delivery and the web's
rendering disagreeing is a bug the reader sees. The server derives delivery and
grant MIME from it; the client derives cards and viewer bodies from the same
kind. Runnable directory grants layer a deliberate subresource override over
that classifier: HTML, JS/MJS, CSS, JSON/maps, fonts and Wasm require their real
loadable types. Images and media still use the shared mapping.

- **Image** (`.png`, `.jpg`, `.webp`, `.gif`, `.avif`, `.bmp`, `.ico`, `.svg`) —
  inline, with `x-content-type-options: nosniff`. SVG also carries
  `Content-Security-Policy: sandbox`, which does nothing while the file loads as
  an `<img>` and turns a direct navigation into an opaque origin that runs no
  script.
- **Text** (`.md`, `.log`, `.csv`, `.json`, and source/config files: `.py`,
  `.ts`, `.css`, `.nix`, `.toml`, …) — inline as `text/plain; charset=utf-8`. A
  browser renders none of these types anyway, and `text/plain` is the one
  document type that cannot execute.
- **Media** (`.pdf`; `.mp4`, `.webm`, `.mov`, `.m4v`, `.ogv`; `.ogg`, `.mp3`,
  `.wav`, `.m4a`, `.aac`, `.flac`) — inline with its real type. The browser's
  own viewer or player handles it; author script does not run.
- **Everything else, HTML included** — `application/octet-stream`,
  `Content-Security-Policy: sandbox; default-src 'none'`, and a
  `Content-Disposition: attachment` whose filename is stripped of CR, LF and
  NUL.

So `/api/files/` never runs HTML. That is what makes it safe to carry the token.

## Grants: where HTML runs

A grant is how an internal HTML document runs and how a browser or Tauri opens
or downloads any internal source without leaking the app token
(`app/server/src/directFileGrants.ts`). The caller chooses `scope=directory`
only for active HTML siblings; other opens and every download use `scope=file`,
which refuses every sibling:

1. The web client POSTs JSON to `/api/file-grants` with the app token: a typed
   `DocumentTarget`, `scope`, and `delivery`. The server resolves host files,
   session artifacts and worktree files (the Knowledge Base included) through
   their authoritative root or registry; no non-host target can supply a
   resolved filesystem path. Artifact session ids accept neither slash style and
   their resolved root must be the exactly named direct child of
   `session-artifacts`. The resolver canonicalizes the source authority and
   selected file, then uses that spelling for the grant directory, containment
   checks and URL name. The document must exist and be a regular file. Directory
   scope is rejected unless the CANONICAL resolved document — not a client
   `.html` spelling or symlink name — is runnable HTML; attachment delivery
   requires file scope. Source identity, scope and delivery are bound into grant
   reuse, so two source authorities over the same inode do not merge powers and
   public URL queries cannot toggle behavior. A compatible live grant is reused
   and expires an hour after minting.
2. Active HTML and SVG responses carry
   `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads`
   — no `allow-same-origin`, so active content lives in an opaque origin with no
   reach into app storage, app cookies or the app DOM. Passive file-scoped PDF
   deliberately omits both response and iframe sandboxing: Chromium/WebKit may
   otherwise block the built-in PDF renderer, and its capability reaches one
   inert file with no siblings.
3. Directory-grant requests resolve relative to that directory and may descend
   but never climb out, so HTML siblings load. For a worktree file this means
   its parent inside the active registered worktree, or inside the Knowledge
   Base folder for the checkout `knowledge`. A file grant resolves only its
   minted name: even a sibling in the same directory is refused. An attachment
   grant adds `Content-Disposition: attachment` with a sanitized ASCII fallback
   filename and an RFC 5987 UTF-8 filename; inline grants add no disposition.

Containment is decided on the CANONICAL path, not the spelling, and that is not
a detail: `..` is the obvious way out and a SYMLINK inside the granted directory
is the one that needs no `..` at all. A link named `report.html` whose target is
`~/.ssh/id_ed25519` reads as perfectly contained, so a lexical check alone would
turn a one-directory capability into the whole filesystem. The identity that
passed the check (device + inode) is then re-checked against the descriptor the
server actually opened, so swapping the file for a symlink afterwards does not
win the race either. `/api/files/` has the opposite rule ON PURPOSE: it serves
whatever path a token holder names, so a symlink there is simply a file.

Grant responses support one `bytes=` range so PDF and media viewers can seek. A
response never sends more than the `content-length` it declared: the stream is
bounded by the size the identity check used. An unbounded read of a file being
appended to would put extra bytes on the wire after a fixed length, which is the
next response's framing on a keep-alive connection rather than merely a longer
document.

`expiresAt` is fixed when the grant is minted. A READ never moves it — the
reader is unauthenticated, so a sliding window would let anyone holding a leaked
id keep it alive forever, which is precisely the case the hour exists for. The
trusted client renews instead: `SandboxedDocument` and an activated media player
re-mint a minute before expiry while mounted. Media stays request-free until its
original Play. Explicit renewal/error recovery requests a fresh id; an ordinary
compatible re-mint still reuses a live grant until its last five minutes.

A timer alone does not survive a frozen page. A phone that sleeps for two hours
resumes with the timeout un-run and a grant that died while nothing was running,
so frames and activated media re-check on `visibilitychange`, `pageshow` and
`focus`. Media renewal preserves position and play/pause intent where the
browser permits seeking/autoplay and surfaces a retry that re-mints on element
failure. A refresh may still be in flight when the reader clicks Open; both
browser and native actions mint before opening whenever the rendered grant is
stale, rather than handing the browser an expiry notice.

External open/download actions follow the same order in a browser and the HTML
viewer. The blank tab is opened SYNCHRONOUSLY, inside the click, because a popup
opened after an `await` is what a blocker refuses; and the fallback for a
blocked popup keys on the tab HANDLE rather than on
`window.open(url, "_blank", "noopener")`, which returns null even when it
succeeded — keying on that return value navigated the reader's own tab away from
the app on the happy path.

The grant id in the path IS the credential, which is why `apiAuthPolicy.ts`
exempts the prefix from both the token and the Origin check: a sandboxed
document sends `Origin: null` and has no token to send. A script in the page can
read its own URL and learns only the id of the directory its own author wrote
into.

Grants are in-memory and re-mintable, so nothing durable has to store one and an
old transcript's card mints a fresh grant when the reader comes back to it.

File-scoped inline grants preserve the shared MIME contract: images, PDF/audio,
Markdown and source/text therefore open as advertised instead of becoming
`application/octet-stream`. Runnable directory grants additionally serve HTML,
JS/MJS, CSS, JSON/maps, fonts and Wasm with loadable real types: the document is
already sandboxed, and a script served as `text/plain` under `nosniff` would not
load. Attachment grants always use `application/octet-stream` plus their bound
attachment disposition.

## What the user sees

Markdown syntax, not layout, picks the presentation. `[label](target)` remains a
link, including when it is the only thing in a paragraph. `![label](target)`
asks for an inline image, media player, or sandboxed internal HTML document.
Structured tool output is the one thing that CARDS: `show_files` emits one
`ShowFilesCardFile` row per file and the transcript draws each as a
`ServedFileCard` — kind icon, name, path, size, Open in viewer and
open/download, with a picture shown inside the card and enlarging into the
lightbox. A row names an ADDRESS and nothing else: it carries no mime and no
kind, the client re-resolves it through the origin-checked target resolver, and
a row that does not resolve to a host file or a session artifact is dropped
rather than drawn. Tool output is untrusted data, so a crafted row can neither
load a foreign picture into the transcript nor dress a document up as one. What
does survive keeps its own identity — a captured artifact keeps its
`/artifacts/...` viewer instead of becoming a host path.
`docs/document-presentation.md` owns that contract and all internal viewer
routes.

`/files/<absolute path>` remains the live host-file route. Markdown renders
through the app pipeline with relative references resolved beside the file, text
stays text, images fit the pane, and HTML uses the same scoped grant. Reload
reaches every renderer: it re-reads the text, re-keys the image URL, re-mints
the HTML and PDF grants, and DISCARDS a granted media player — back to Play,
with no `src` and no request until the reader presses it, exactly as on a first
visit. A renderer that keeps its own granted URL takes the viewer's reload
generation, or it silently shows the previous bytes.

Captured artifacts now have `/artifacts/<session>/<path>` viewer routes. They
preserve session identity and can navigate to sibling artifacts. Captured HTML
runs only through its own session-directory grant, never a host grant.

Neither inline presentation nor a viewer adds bytes to an agent's context.

## The agent-facing half

`config/prompts/chat-files.md` is the shared, unconditional prompt layer that
states the `/api/files/` URL form and what each kind renders as. It is what
makes a hand-written Markdown link the normal way to show a file.

`show_files` (`app/server/src/tools/core/showFilesTool.ts`, deferred) exists for
what a hand-written link cannot do: confirm the file is there, report its size,
and put the file itself in the chat as a card — its structured output is the
card, so it shows even when the agent pastes nothing and even with tools hidden.
The payload also carries the correctly escaped snippet for each file's kind, for
an agent placing the file inside its own reply. It accepts a path or an address
the app already serves, and copies nothing.

Its two inputs follow the two containment rules above, and the difference is
deliberate. A host path is whatever the caller names: `/api/files/` has no
allow-list and no symlink rule, because an agent may already read anything the
service can. An artifact address is a SOURCE AUTHORITY, so the tool takes the
session-id guard the grant resolver exports (`assertArtifactSessionId`, one
question both halves ask), then canonicalizes the session root and the selected
file with `realpath` and refuses anything that lands outside — the same rule for
the same reason (a link named `escape.png` inside the session directory needs no
`..` to reach `~/.ssh/id_ed25519`). The canonical spelling is then what the card
shows and links to.

A card must survive a reload, so `show_files` is registered in
`session/log/timelinePayloadPolicy.ts`: its payload is kept whole rather than
clipped to the inline budget, exactly like the other card-bearing tools.
