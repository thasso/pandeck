# Confluence integration

Confluence is a Cloud wiki integration that reads pages as Markdown and writes
them through the same approval gate Jira mutations use. It is a separate
integration from Jira with its own `confluence` tool gate, but it holds **no
credentials of its own**: it is the same Atlassian site, reached with the same
account email and API token that `jiraSettings.ts` stores.

## At a glance

|                          |                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| Auth model               | Atlassian Basic auth, borrowed from the Jira integration                                 |
| Runtime settings file    | `DATA_DIR/settings/confluence.json` (only `enabled`)                                     |
| Static deployment config | `confluenceHost` (`config.ts`, defaults to `jiraHost`)                                   |
| Tool gate                | `confluence`                                                                             |
| Owning modules           | `app/server/src/confluenceSettings.ts`, `app/server/src/atlassian/`, `tools/confluence/` |
| Agent tools              | 5: search, get_page, lookup, download_attachment, mutate_page (`confluence_` prefix)     |
| Approval kind            | `confluencePage`                                                                         |

## Credentials come from Jira

`getConfluenceToolConfig()` composes `CONFLUENCE_HOST` with the credentials
`getJiraCredsIfAvailable()` returns. Unlike Tempo, Confluence cannot degrade
when Jira is off — every Confluence call is authenticated — so its tools fail
fast with a message naming Settings → Jira rather than returning a partial
answer. The two gates stay independent: enabling Jira never exposes Confluence
tools, and the Settings page for Confluence offers only an enable switch, the
read-only host, and a connection test.

`CONFLUENCE_HOST` comes from `ASSISTANT_CONFLUENCE_HOST` → `app.json`
`confluence.host` → `JIRA_HOST`. The fallback is the normal case; the override
exists for a deployment that splits the two products across hosts.

The connection test calls `GET /wiki/rest/api/user/current` for a name and
accountId, and falls back to `GET /wiki/api/v2/spaces?limit=1` when a site
refuses the identity call — reachability is what the tools actually need.

## Two API versions, on purpose

Pages, spaces, comments, labels and attachments are read and written on **v2**
(`/wiki/api/v2`). CQL search never moved to v2, so `confluence_search` uses
**v1** (`/wiki/rest/api/search`), and label writes are v1 as well
(`/wiki/rest/api/content/{id}/label`), as are attachment uploads, which v2 has
no endpoint for. `atlassian/confluenceClient.ts` owns both and
`atlassian/atlassianFetch.ts` is the single transport, shared with
`jiraClient.ts`: reads retry through `httpRetry.ts` because Atlassian answers
bulk work with 429, and a write gets ONE attempt so a page the server already
committed is never replayed.

Two API details cause most failures and are handled centrally:

- An ADF body travels as a JSON **string** in `body.value`, never as a nested
  object (`adfBodyPayload`).
- `/wiki/api/v2/pages/{id}/footer-comments` returns only top-level comments;
  replies need `/wiki/api/v2/footer-comments/{id}/children`, which
  `confluence_get_page` walks so a discussion does not read as unanswered.

## Formatting: ADF both ways

Confluence and Jira share Atlassian Document Format, so the converters live in
`app/server/src/atlassian/` and serve both products:

- **Write** — `adfFromMarkdown.ts#markdownToAdf` maps CommonMark/GFM to native
  ADF (headings, marks, links, lists, task markers, quotes, code, rules,
  tables). Raw HTML is preserved as an HTML code block and images become linked
  alt text: a real Confluence image needs an uploaded attachment plus
  `mediaSingle`/`media` nodes. Attachments can be uploaded, but a body does not
  create the nodes that embed them.
- **Read** — `adfToMarkdown.ts` renders the much wider node set a page uses.
  Tables become GFM, panels become labelled blockquotes, expands keep their
  title, task and decision lists become checkable items, `status` and `date`
  render inline, layouts flatten to sequential blocks, and macros
  (`extension`/`bodiedExtension`/`inlineExtension`) become a visible
  `[macro: name param=value]` marker with their body underneath. Media becomes
  `[attachment: name]`. **Nothing renders as an empty string**: a silently
  dropped macro reads as a page that says less than it does.
- **Legacy fallback** — a page whose content predates the current editor can
  answer `atlas_doc_format` with an empty body. `fetchPageWithBody` then
  re-requests `body-format=storage` and `storageToMarkdown.ts` converts the
  XHTML with Turndown plus explicit rules for tables, `<ac:structured-macro>`
  and `<ri:attachment>`. The page reports which representation it came from as
  `bodySource`.

## Writes never round-trip a page through Markdown

`markdownToAdf` can only produce the nodes Markdown has. Rebuilding a page from
its own Markdown rendering therefore deletes every macro, layout and image on
it. The write path is built around that fact:

- **`append` (the default) and `prepend` splice ADF.** `spliceAdf` concatenates
  the new document's blocks with the page's existing ADF blocks, so untouched
  content — including everything Markdown cannot express — survives verbatim.
- **`replace` is the only destructive placement.** It has to be named
  explicitly. `lossyAdfNodes` lists the node types the page holds that Markdown
  cannot carry back; they travel on the proposal as `lossyNodes`, the tool
  reports them as a warning, and the approval card states them above the Approve
  button.
- **A legacy storage-format page refuses `append`/`prepend`** with an error
  telling the agent to confirm a rewrite and propose `replace` instead: there is
  no ADF to splice into, and silently rewriting the page would be the worst
  outcome.
- **The splice target is a CHECKED document, not "some JSON".** `parseAdfBody`
  requires a root `{ type: "doc", content: [...] }`; `"text"`, `{}` and `[]` all
  parse as JSON but have no blocks, and splicing into one would write the
  addition alone over the page. Anything else is treated as no ADF at all, which
  sends the read to the storage fallback and makes the write refuse. `spliceAdf`
  takes that validated document as its type, so the check cannot be skipped by a
  new caller.

## Version safety

An approval can sit unanswered for minutes. `confluence_mutate_page` records the
page version it prepared against as `baseVersion`; `readVerifiedPage` re-reads
the page at execution and refuses when the version moved, rather than writing
`version.number = n+1` over somebody else's save. Confluence's own optimistic
locking would not catch this, because the executor would be sending the newer
number.

Three properties make that guard total rather than best-effort:

- **Every write to an existing page verifies**, including `delete`. A delete has
  no version precondition in the API and nothing to undo afterwards, so it gets
  the same re-read; the remaining window is one round trip rather than the whole
  approval wait, and the API cannot close it entirely.
- **A page that reports no version cannot be proposed against at all.** Staging
  refuses, because an absent `baseVersion` leaves nothing to compare later.
- **A missing `baseVersion` at execution is a refusal, not a skipped check.** A
  card persisted before that staging rule existed fails instead of writing
  unverified.

## Tool surface

- **`confluence_search`** — CQL search. Named filters (`text`, `title`,
  `spaceKeys`, `label`, `type`, `updatedSince`) compile to CQL, with a raw `cql`
  escape hatch used verbatim. Returns compact rows (id, title, space, url,
  excerpt) and never a body; `nextStart` continues the listing.
- **`confluence_get_page`** — one page as Markdown, `maxChars` bounded (12000
  default, 1000 floor) with an explicit `truncated` flag. Comments (with
  replies), labels, children and attachments are opt-in. Reports `lossyNodes`,
  `bodySource` and `version`.
- **`confluence_lookup`** — discovery and continuation in one tool: `spaces`,
  `pageTree` (the direct children of a page, or every page in a space at any
  depth — the v2 space endpoint is not root-only), `labels`, `attachments`,
  `comments`, and `replies` for one comment's thread. Every kind takes
  `maxResults` and `cursor` and returns `nextCursor`.
- **`confluence_download_attachment`** — one attachment, by id or by page and
  file name, into the session attachment store (source `confluence`). The result
  is the session attachment id and host path, never the bytes, so the file
  continues into `read_attachment`, `convert_pdf`, `kb_write` or an upload. 50
  MiB by default, 100 MiB at most; a larger file is refused rather than
  truncated.
- **`confluence_mutate_page`** — approval-gated `create`, `edit`, `comment`,
  `delete`, `uploadAttachment` and `deleteAttachment`, at most 10 items per
  approval. Every item is validated against the live site before the approval is
  staged, so a missing space, an unreadable page or an unsupported placement is
  a tool error rather than an approval that can only fail.

## Attachments

Attachment writes live in `tools/confluence/confluenceAttachments.ts` and ride
the same `confluencePage` approval as page writes, with an `attachment` object
on the item.

- **`uploadAttachment`** takes its bytes from `sourceAttachmentId` (a session
  attachment) or `sourcePath` (an absolute host path). The file name defaults to
  the source's; naming an attachment the page already has, or passing its
  `attachmentId`, uploads a new version of it, and `versionMessage` becomes the
  version comment. A new file posts to `…/child/attachment`, a new version to
  `…/child/attachment/{id}/data`, both multipart (`atlassianFetch` sends a
  `FormData` body with `X-Atlassian-Token: no-check`).
- **`deleteAttachment`** moves one attachment to the trash through
  `DELETE /wiki/api/v2/attachments/{id}`.

**What uploads is what was approved.** Staging copies a host file into the
session attachment store and records the copy's id and SHA-256 on the item. A
session attachment source is pinned the same way. Execution re-hashes the staged
bytes and refuses on a mismatch or a missing file, so editing the source after
proposing does not change the upload.

**Attachments carry their own version guard.** Confluence versions an attachment
separately from its page, so page `baseVersion` says nothing about it. Staging
records the version of the attachment an upload replaces or a delete removes,
and execution re-reads it and refuses on drift. The same thing happens when a
proposed new file finds that a file with the same name was added in the
meantime. An attachment item neither needs nor records a page version.

**Downloads send credentials only to the site.** `atlassianDownload` takes a
site-relative path only. Confluence redirects an attachment download to
Atlassian's media host with a signed URL; fetch drops `Authorization` on that
cross-origin hop.

## Nothing truncates silently

Every listing these tools read is paged, and each one answers with the cursor to
continue at: `nextStart` for CQL search, `nextCursor` for each
`confluence_lookup` kind, and `moreComments` / `moreLabels` / `moreChildren` /
`moreAttachments` beside the optional sections of `confluence_get_page`, plus
`moreReplies` on a comment whose thread ran past one page. A null cursor means
the list is complete. This mirrors the rule the Tempo read tools already follow
(`docs/jira-tempo.md`): a page that reads as complete when it is not is worse
than one that says it has more.

**Every cursor these tools report is accepted back by one of them.** That is the
half that makes the rule worth anything: a cursor with nothing to hand it to
only names what the reader cannot reach. `confluence_lookup` is the continuation
surface for all of them, which is why it carries `comments` and `replies` kinds
alongside the discovery ones — `moreComments` continues as `kind=comments` with
`page` and `cursor`, and `moreReplies` as `kind=replies` with the comment's
`commentId` and `cursor`. `moreReplies` is that cursor, not a boolean, for the
same reason.

## Protocol and UI

`app/shared/protocol.ts` carries `ConfluenceSettings`,
`ConfluenceSettingsPatch`, `ConfluenceConnectionStatus`, the client messages
`updateConfluenceSettings` / `saveAndTestConfluenceSettings` /
`testConfluenceSettings`, the server message `confluenceStatus`, and the
`confluencePage` approval body with `ConfluencePageMutationItemDisplay`.

The proposal's `currentBody` is clipped to 4000 characters on the server: it is
edit context for the card, not the page's content, and a full page body has no
business crossing the wire on every proposal.

`ConfluencePageApprovalBody.tsx` renders each item as the write it will be — the
action, the target page and space, the Markdown body as Confluence will show it,
label changes, and the loss warning for a `replace` or a `delete`. An attachment
item shows the file name, size, media type, whether it is a new file or which
version it replaces, where the bytes came from, and a trash warning for a
delete.
