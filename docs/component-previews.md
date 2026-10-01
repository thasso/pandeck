# Component stories in chat

Storybook is the source of UI preview cases. The chat adapter builds one of
those same stories into an immutable HTML generation that the assistant embeds
in its next reply. A preview imports production components and
`app/web/src/index.css`; it does not copy their markup or styling.

## Authoring stories

Storybook configuration and stories live under `app/web/component-preview/`. Run
the catalog locally with:

```bash
pnpm --filter @assistant/web storybook
```

A surface story starts with wire-level fixture data and renders the production
composition that owns the component. For example, the attention-list stories
pass `SessionListItem` rows to `SessionInbox` inside the same aside and scroll
wrapper used by `Sidebar`. `SessionInbox` still owns status classification,
ordering, relation joins, cluster shaping and the `ActiveSessionCard` props. Do
not hand-build those derived values in a story.

`PaPreviewRoot` owns the shared app providers and the document-level theme and
text-scale attributes. Storybook's toolbar changes those attributes. Story args
control inputs owned by the host, such as rail width and row density. Viewport
parameters distinguish a narrow desktop rail from a phone: both may render a
similarly sized list, but their media queries and host density decisions differ.
`preview.css` explicitly scans `src/` for Tailwind utilities. Keep that source
directive: following imports alone omits production classes and creates a
plausible but unstyled imitation.

Register chat-buildable cases in `storyCatalog.ts` and `storyRegistry.tsx` with
the same stable ID as the CSF story. The catalog records the canvas viewport,
component-frame width, theme and text scale; the registry reuses the CSF story's
args rather than defining a second fixture.

## Building a chat preview

Build one case with:

```bash
pnpm --filter @assistant/web preview:story -- session-inbox--attention-mix
```

The command prints the absolute document path and the Markdown image syntax for
embedding it. Every distinct output is stored under
`component-preview/dist/<content hash>/`. A reply embeds that generation, so a
later build cannot change an older transcript preview after it remounts. The
latest assistant reply always carries the latest preview; there is no reload
workflow that sends the reader back through the transcript.

The generated outer document identifies the story, frame width, appearance and
source revision. It clips a nested story canvas to the production frame width.
The nested canvas keeps its own configured viewport, so a 256px rail evaluates
desktop media queries while a 390px phone evaluates mobile ones. Chat's generic
HTML embed is a 384px-tall scrolling window; use Open in viewer to inspect the
whole phone frame. Removing the worktree also removes its generated previews, so
transcript embeds are immutable for the worktree's lifetime, not permanent
artifacts.

## Sandbox constraint

Chat runs internal HTML with scripts enabled but gives it an opaque origin. ES
module subresources would require CORS from that origin, so the adapter emits
one classic IIFE bundle and one stylesheet. Both generated documents remain
inside the existing directory-scoped file grant. They cannot read the app DOM,
token, cookies or storage, and stories must not call app APIs.

The full Storybook manager is local development UI and is never embedded in chat
or included in the production web build. `component-preview/dist/` and
`component-preview/storybook-static/` are generated and ignored by Git.
