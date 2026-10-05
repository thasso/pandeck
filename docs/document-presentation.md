# Document presentation

This document defines how a document address becomes a link, card, inline embed,
or viewer. `app/shared/documentTargets.ts` owns target parsing and formatting.
The web resolver and every document entry point consume that type.

## Intent and source are separate

Markdown syntax states presentation intent:

- `[label](target)` is a link. Its position in a paragraph does not change it
  into a card.
- `![label](target)` asks for an inline embed. The app embeds supported image,
  audio, video, and HTML targets. PDF and unsupported targets degrade to an
  ordinary internal viewer link.
- `[![label](image)](target)` is a link whose label is a picture. The authored
  outer link is kept for internal and foreign destinations alike, the image
  renders inside that one anchor, and the standalone embed's own controls are
  dropped: no anchor and no button may be nested in a link. A linked target that
  is not an image degrades to the link's text. An image with no `label` takes
  its accessible name from the destination.
- Structured tool output is a card, and the ONLY thing that is: `show_files`
  answers with one card per file (`ServedFileCard`), which names the file and
  its size, previews a picture inline, and offers the same Open in viewer action
  plus an external open or download. A card row states an address and nothing
  else. Source AND kind are re-derived from it through this resolver — no
  producer-supplied mime or kind decides, and a row that does not resolve to a
  supported internal source is dropped rather than rendered — so a captured
  artifact keeps its artifact viewer route and a foreign address gets no card at
  all.

The target states where bytes come from. Presentation code must not guess the
source from layout or infer a worktree from an absolute host path. Links,
embeds, and cards call the same origin-checked web resolver before any
classification, fetch, or grant mint. External `http:` and `https:` links remain
external even when their pathname resembles `/api/files/...`; only absolute URLs
on the configured app/server origins may enter the internal viewer. Shared code
parses app-relative and `pa://` addresses, never HTTP origins.

## Typed targets and routes

`DocumentTarget` has these sources:

| Source           | Durable input                                            | Viewer route                                         |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Live host file   | `/api/files/<absolute path>`                             | `/files/<absolute path>`                             |
| Session artifact | `/api/session-artifacts/<session>/<path>`                | `/artifacts/<session>/<path>`                        |
| Knowledge file   | `/api/knowledge/file?path=...` or `/knowledge/~file/...` | `/knowledge/~file/<tree path>`                       |
| Knowledge asset  | `pa://knowledge/<entry>?asset=<relative path>`           | `/knowledge/<entry>?asset=<relative path>`           |
| Worktree file    | `pa://worktree/<id>?path=<repo path>`                    | `/worktrees/<id>/files?path=<repo path>`             |
| Worktree diff    | `pa://worktree/<id>?path=<repo path>&view=diff`          | `/worktrees/<id>/changes?path=<repo path>&view=diff` |

A worktree target without `view=diff` always opens the ordinary file. A changed
file is still a file unless the author explicitly asks for its diff. Worktree
identity comes from the worktree id in the URI or route, never from a filesystem
prefix.

A viewer route usually ends in the document's own extension
(`/files/tmp/plan.md`), and a reload or shared link must still open the app. The
production server (`app/server/src/webStatic.ts`) therefore answers any missing
NESTED path with the SPA shell, extension or not, and 404s only a miss under
`/assets/`, `/api/`, `/mcp/` or `/.well-known/`, or a missing top-level file
such as `/favicon.xyz`. That rule holds only while `app/web/public` stays flat
(`webStatic.test.ts` asserts it).

A target may end in `#L42` or `#L42-L57`. Lines are 1-based, and the range is
inclusive. BOTH endpoints must be positive safe integers in order: a zero,
reversed, fractional, or too-large-to-be-exact line number (`#L1-L1e21`, a
forty-digit run) drops the whole anchor at parse time, and formatting an anchor
is total — an address it cannot express yields no fragment rather than throwing
inside a render.

Source renderers scroll the first line into view and visibly highlight every
supported text or worktree line intersecting the inclusive range — as ONE
continuous region, not a box per line — up to `MAX_DOCUMENT_ANCHOR_LINES` (500)
lines of automatic work. The address itself is never rewritten: `#L1-L500000`
stays in the URL and in every link, and `boundedDocumentLineRange` is what a
renderer draws — the whole range when it fits, otherwise the cap counted FROM
the first addressed line.

Every line-oriented body — a host file, a captured artifact, a Knowledge file —
is the SAME renderer, so the sources cannot answer one address three ways. It
opens on a window of that same 500-line size whether or not there is an anchor:
centred on the addressed lines when they fit, and starting at the first
addressed line when they do not. Line 500,000 of a huge file therefore costs
what line 5 costs, a 500,000-line range costs what a five-line range costs, and
a newline-heavy file with no anchor at all costs the window. Initial DOM work is
O(window); the full text is kept only as data, which is what copy and download
hand over whole. Reveal controls grow the window in both directions and nothing
auto-expands past it. The renderer names the addressed lines itself so the mark
survives its own re-renders (a deferred syntax highlight, a further reveal).
Observers waiting for late or virtualized content are bounded, re-mark content
that replaces a marked line within that window, scroll only once, and disconnect
when the addressed line cannot appear.

Where only part of the requested range is drawn, the surface says which part, in
one shared sentence (`lib/documentRange.ts`) — a line-oriented body says it
beside its reveal controls, and a renderer that has none (rendered Markdown, a
worktree file or diff surface) says it above the content. A range longer than
the document is not a partial range: everything it names that exists is shown.

Markdown is the one source addressed by source line but rendered in BLOCKS. It
renders whole — its DOM follows its own block structure, which the address
cannot inflate — and the anchor marks every block intersecting the bounded
range, never a block beyond it. A worktree file or diff surface selects the
bounded range and draws it through pierre.

A same-document `#Lx` reference keeps the current target and replaces its
anchor. Other relative links keep the current source identity without inheriting
the source anchor. Paths use URL resolution and percent-decode exactly once. A
host document links to another host file, an artifact links within the same
session artifact directory, a Knowledge document stays in Knowledge, and a
worktree document stays in the same worktree. Relative worktree links reset to
ordinary file view. A link must say `view=diff` again to open a diff.

## Starting a session from a document

Every document viewer — a host file, an artifact, a Knowledge file or entry, a
worktree file — leads with "Start session with this file" (the route's primary
action in `App.tsx`, `lib/fileSessionStart.ts`). It stages the document as a
`file-context` chip on the new-session composer. A file inside a worktree also
stages that worktree, so the session runs in the checkout the file belongs to.

On the wire the staged file is its canonical viewer route without the line
anchor (`fileContext` on `prompt` and `harnessSend`). The server parses it as a
`DocumentTarget` and resolves the absolute path through the same source
authority a grant uses (`resolveDocumentTargetPath`), so the client cannot name
a path the viewer could not open. The first turn carries a `file-context`
attachment holding the file's name, absolute path and route — never its content:
the agent reads the file when it needs it. A file outranks a Project and yields
to a Task (`sessionContext.ts`), and an unresolvable target attaches nothing.

## Navigation shell

`DocumentNavigationShell` surrounds source-specific renderers. It owns document
identity and the three distinct navigation commands:

- Back and Forward traverse app-owned history and disable at its ends.
- Close returns to the exact history entry that first opened the document stack,
  including its query and fragment. Opening another internal document pushes
  history, carries that origin, and preserves Forward when the reader traverses
  back.
- A deep-linked document has no opening entry. Close then uses a deterministic
  source fallback: the owning Session for an artifact, Knowledge for a Knowledge
  file, the worktree Files view for a worktree file, and Sessions for a live
  host file. Knowledge assets fall back to their owning entry, and an explicit
  worktree diff falls back to Changes.

Host, artifact, Knowledge, and worktree renderers keep their own fetch and
rendering rules. The shell does not route every source through `FileViewerPage`.
On a phone it renders only the compact identity row. Back, Forward, Close, and
typed source actions register with the existing object dock and bottom-card
system, composed with worktree comment/review/start-session actions. One builder
owns that row's order (`components/DocumentDockRow.tsx`), so no source can
reorder it: Back and Forward are the fixed leading pair, the source's and
object's actions fill the middle, and Close is fixed at the FAR RIGHT end. A
document with source and worktree actions overflows that middle at 360px and it
scrolls horizontally — which is why both ends sit outside it (`DockPeek.back`
and `DockPeek.trailing`): neither the way back nor the way out may scroll away.
It does not add a fixed toolbar. Route-level registration exists outside lazy
viewer bodies, so the dock never flashes the previous screen's action set. A
wide layout puts the same controls in the identity header, in the same order:
Back and Forward first, Close last.

## Rendering and security

The delivery rules in `served-files.md` still apply. HTML from every internal
source runs only through a typed, directory-scoped opaque grant. Host paths,
session artifacts, Knowledge files/assets and worktree files keep their source
identity through minting; the server resolves that identity through the owning
root or registry and never accepts a client-resolved filesystem path. Source
viewers keep their natural fetch/render context. PDFs use passive file-scoped
grants and omit response/iframe sandboxing so Chromium/WebKit's built-in viewer
is not plugin-blocked; active HTML/SVG remains sandboxed. A PDF is EMBEDDED only
where the engine can scroll one. On iOS and iPadOS WebKit — every browser there,
an installed Home Screen app, and the shell's WKWebView — a framed PDF is its
first page at native size with nothing to scroll, so the dedicated viewer
renders a panel instead: the file's name, its size where the source knows it, a
line saying the document opens in the browser, and one action that hands the
same grant to a real tab (the native opener in the shell). An inline PDF embed
keeps degrading to its canonical viewer link. A framed document in a dedicated
viewer fills that viewer's panel — the frame and everything wrapping it carry
the height, since a frame whose height cannot resolve collapses to the browser's
150px default — while an inline embed stays bounded. Unsupported bytes retain
Open and Download actions.

An explicit image embed is bare and lazy, and it enlarges: clicking it opens the
full-screen image viewer rather than leaving the surface the reader is on. That
viewer is a portaled takeover, so it keeps the shell's safe-area insets and
viewport height and never hides its own close control under a notch. An image
inside an authored link stays inert, since that anchor owns the click.
Audio/video show an accessible Play control and have no `src` or grant request
before it is pressed; activation mints a file-scoped grant. An activated player
renews before expiry and on visibility/focus return, preserves position and
play/pause intent where the browser permits, and exposes an element-error retry
that forces a fresh grant. Video plays inline, never taking iOS fullscreen out
from under the surface it was started in. Inline HTML from every internal source
is visibility-gated and uses a bare bounded opaque sandbox. Its only chrome is a
small Open in viewer action. Relative CSS/JS/images/media resolve within the
typed source directory grant. No frame URL carries the app token or
`allow-same-origin`; a source that cannot establish that directory degrades to
its canonical internal viewer link.

In Tauri, same-origin Open/Download actions never navigate the webview or put
the main app token in browser history. Every source mints a short-lived grant
and passes only that URL through the narrowly validated `open_served_file`
command. Download grants bind attachment delivery to one file; Open uses one
file except for runnable HTML, whose directory grant lets authored siblings
work. Ordinary browsers use the same token-free grants. An old shell that lacks
the command fails closed and reports the failure; it never falls back to a raw
or token-bearing URL.

Each history entry owns the designated outer viewer's scroll offset. Scroll
updates are coalesced and flushed before navigation or unmount; nested code
scrollers never overwrite it. A page that registers as an embedded marker and
lays out its own panes — the worktree file and diff views — attaches that same
behaviour to its own scroller instead of gaining a second registration, and a
pane that arrives with its data is waited for within the same bounds.
Back/Forward wait for enough late content before restoring, while a line anchor
takes precedence. Scroll inside an opaque HTML iframe or embedded PDF belongs to
that renderer and cannot be restored by the app. A deep-linked document edge
Back invokes Close's source fallback rather than disarming.

Viewer zoom belongs to the designated document scroller, never the app or
WKWebView. Markdown, source and text zoom by recomputing the local typography
roles, so lines reflow at the existing content width. Images, rendered HTML,
PDFs and media scale inside that scroller and pan through its ordinary scroll.
Text is bounded to 75–200%; visual content to 50–400%, in 25% control steps.
Zoom is keyed by anchor-free document identity: same-document anchor
Back/Forward preserves it, while a different target resets it. The mode follows
the renderer ON SCREEN, never the pivot's name: worktree source and Changes are
text, a Preview is text when it renders Markdown — which reflows through the
same typography variables — and visual for an SVG, HTML, media or PDF preview,
and an image is visual on its FILE pivot, which is the only one it has. A PDF
that took the open-in-your-browser panel above registers NO zoom: the panel is
not the document, so enabled controls would move a scale nothing on screen
reads. The current scale is clamped to the new mode's bounds when that renderer
changes. Route-only lazy markers publish no disposable zoom controls. A wide
header keeps its accessible −, reset and + controls between the document's other
actions and Close. A phone does NOT: the resting dock row is where a document is
left (Back and Forward leading, Close pinned right) and where its source and
review actions live, and a worktree document already overflows it, so the
detailed controls — −, the current percentage, reset, + — are a section of the
dock's EXPANDED sheet, which is also the only way a keyboard or switch user
reaches them. The compact identity row and the dock itself stay unzoomed. The
app claims NO touch gesture for zoom: the page is zoomable, so a pinch is the
browser's own, which works over every part of the document — including an opaque
iframe, where a gesture handler of the app's could never have reached anyway —
and needs no `touch-action` carve-out that would compete with scrolling and
selection. The controls above are the app's answer for an exact scale.
