import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  FileText,
  Image as ImageIcon,
  Link2,
  Paperclip,
} from "lucide-react";
import {
  formatPaObjectLink,
  type PaObjectLinkResolution,
} from "@assistant/shared/objectLinks";
import type {
  KnowledgeEntryAsset,
  KnowledgeEntryDocument,
  KnowledgeEntryHeading,
  KnowledgeEntryResponse,
} from "@assistant/shared/knowledgeBase";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { Markdown } from "./Markdown.tsx";
import { CollapsibleSection } from "./CollapsibleSection.tsx";
import { RefreshIndicator } from "./ui/load.tsx";
import {
  DocumentCommentLayer,
  useDocumentCommentsEnabled,
} from "./DocumentComments.tsx";

/**
 * @component KnowledgeEntryViewer
 * @purpose Main-pane document surface for one first-class KB entry:
 * frontmatter-derived metadata, a contents outline, rendered Markdown, entry
 * assets, and the entry's comment tray.
 * @useWhen Rendering `/knowledge/:entryId` once the entry document is loaded.
 * @avoidWhen Editing entry source or browsing the tree (sidebar `KnowledgeBrowser`).
 * @intent The container owns fetching; this surface owns the rendered document.
 * Comments are the shared browser-local tray (`DocumentCommentLayer`), not
 * server state. Invalid entries remain readable without comment affordances.
 * @related Markdown (link rendering), knowledgeEntry.entryLocalAssetHref.
 */
export function KnowledgeEntryViewer({
  back,
  headerActions,
  resource,
  resolveAssetUrl,
  onOpenPaObject,
  onCopyLink,
  refreshing = false,
}: {
  /** Mobile screen back control (ui-shell.md, Small Screens). */
  back?: PageHeaderBack | undefined;
  /**
   * Host controls for the identity row, ahead of the viewer's own. The side
   * panel puts "Open in Knowledge" here: the entry's header is where the reader
   * already looks for what to do with it.
   */
  headerActions?: ReactNode;
  resource: KnowledgeEntryResponse;
  /** Resolve an entry-local `assets/...` path to an absolute, loadable URL. */
  resolveAssetUrl: (assetPath: string) => string;
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  /** Copy a durable `pa://` reference; container owns clipboard + feedback. */
  onCopyLink?: (uri: string, label: string) => void;
  /**
   * A refetch of THIS entry is running (R2): the document stays exactly as it
   * is and the header marks it, so an invalidation never blanks what is read.
   */
  refreshing?: boolean;
}) {
  if (resource.kind === "invalid") {
    return (
      <InvalidEntry
        back={back}
        headerActions={headerActions}
        resource={resource}
        refreshing={refreshing}
      />
    );
  }
  return (
    <EntryDocument
      back={back}
      headerActions={headerActions}
      entry={resource}
      resolveAssetUrl={resolveAssetUrl}
      onOpenPaObject={onOpenPaObject}
      onCopyLink={onCopyLink}
      refreshing={refreshing}
    />
  );
}

function EntryDocument({
  back,
  headerActions,
  entry,
  resolveAssetUrl,
  onOpenPaObject,
  onCopyLink,
  refreshing,
}: {
  back?: PageHeaderBack | undefined;
  headerActions?: ReactNode | undefined;
  entry: KnowledgeEntryDocument;
  resolveAssetUrl: (assetPath: string) => string;
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  onCopyLink?: ((uri: string, label: string) => void) | undefined;
  /** Marks a same-entry refetch without touching the document (R2). */
  refreshing: boolean;
}) {
  const sourceAssets = entry.assets.filter(
    (asset) => asset.kind === "source" && asset.exists,
  );
  const commentable = useDocumentCommentsEnabled();
  const markdownRoot = useRef<HTMLElement | null>(null);
  /**
   * Bumped whenever the rendered article is a NEW element. A remount (rotating a
   * phone, a layout crossing the mobile breakpoint) detaches the Ranges a
   * registered highlight holds, so only the node's identity can tell the
   * comment layer to paint again.
   */
  const [rootVersion, setRootVersion] = useState(0);
  const attachMarkdownRoot = useCallback((node: HTMLElement | null) => {
    markdownRoot.current = node;
    if (node) setRootVersion((version) => version + 1);
  }, []);
  const [linkCopied, setLinkCopied] = useState(false);
  const commentDocument = useMemo(
    () => ({
      kind: "knowledgeEntry" as const,
      entryId: entry.id,
      title: entry.title,
    }),
    [entry.id, entry.title],
  );

  const outlineNodes = useMemo(
    () => buildOutlineTree(entry.outline, entry.title),
    [entry.outline, entry.title],
  );

  /**
   * Scroll the rendered document to a heading. Matched by TEXT against the
   * rendered `h1…h6` nodes rather than by an id, because the Markdown renderer
   * emits no heading slugs; the outline comes from the same body, so the nth
   * heading of a level always has a counterpart in the DOM.
   */
  const jumpToHeading = useCallback((heading: KnowledgeEntryHeading) => {
    const root = markdownRoot.current;
    if (!root) return;
    const match = [
      ...root.querySelectorAll<HTMLElement>(`h${heading.level}`),
    ].find((element) => element.textContent?.trim() === heading.text);
    match?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* One compact identity row: the title stays visible while the document is
          read or scrolled. The glyph marks this as a KB entry and copies its
          `pa://` link; richer frontmatter metadata belongs in the panel. */}
      <PageHeader
        back={back}
        density="compact"
        icon={
          linkCopied ? (
            <Check size={16} strokeWidth={2.5} />
          ) : (
            <BookOpen size={16} />
          )
        }
        iconTone="accent"
        onIconClick={
          onCopyLink
            ? () => {
                onCopyLink(entry.uri, entry.title);
                setLinkCopied(true);
                window.setTimeout(() => setLinkCopied(false), 1200);
              }
            : undefined
        }
        iconLabel={linkCopied ? "Copied!" : "Copy entry link"}
        title={entry.title}
        actions={
          <>
            {headerActions}
            <HeaderActions refreshing={refreshing} />
          </>
        }
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {entry.summary ? (
            <p className="rounded-xl border border-line bg-panel/60 px-4 py-3 text-body text-muted">
              {entry.summary}
            </p>
          ) : null}
          {/* Tags are frontmatter, so they read as metadata in the panel's
              Summary section rather than as chips between the reader and the
              document. */}
          {outlineNodes.length > 0 ? (
            <ContentsOutline
              nodes={outlineNodes}
              entry={entry}
              onCopyLink={onCopyLink}
              onJump={jumpToHeading}
            />
          ) : null}
          {entry.markdown ? (
            <article ref={attachMarkdownRoot} className="min-w-0">
              <Markdown
                text={entry.markdown}
                paObjectReferences={entry.paObjectReferences}
                onOpenPaObject={onOpenPaObject}
                sourcePositions={commentable}
                documentTarget={{
                  kind: "knowledgeAsset",
                  entryId: entry.id,
                  path: "index.md",
                }}
              />
            </article>
          ) : (
            <p className="text-body text-faint">
              This entry has no body content yet.
            </p>
          )}
          {sourceAssets.length > 0 ? (
            <AssetsSection
              assets={sourceAssets}
              resolveAssetUrl={resolveAssetUrl}
            />
          ) : null}
        </div>
      </main>
      <DocumentCommentLayer
        document={commentDocument}
        rootRef={markdownRoot}
        lineSource="markdown"
        rootVersion={rootVersion}
      />
    </div>
  );
}

/** One outline entry plus the headings nested under it. */
interface OutlineNode {
  heading: KnowledgeEntryHeading;
  children: OutlineNode[];
}

/**
 * Nest a flat heading outline by level. A LEADING level-1 heading that repeats
 * the entry title is dropped: every entry opens with its title as an H1, and a
 * contents tree rooted at "the document" says nothing. Levels that skip a step
 * (`##` straight to `####`) still nest under their nearest shallower ancestor,
 * so a sloppy document still produces a tree rather than a flat list.
 */
function buildOutlineTree(
  outline: KnowledgeEntryHeading[],
  title: string,
): OutlineNode[] {
  const headings =
    outline.length > 0 &&
    outline[0]!.level === 1 &&
    outline[0]!.text.trim() === title.trim()
      ? outline.slice(1)
      : outline;
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const heading of headings) {
    const node: OutlineNode = { heading, children: [] };
    while (
      stack.length > 0 &&
      stack[stack.length - 1]!.heading.level >= heading.level
    )
      stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }
  return roots;
}

/**
 * The document's structure, inline rather than in a card: a collapsible section
 * flush with the page column (like the Task page's sections), whose body is the
 * real heading TREE — always expanded, since it exists to be read at a glance.
 * A row scrolls the document to that heading; the hover link copies a deep
 * `pa://` link to it.
 */
function ContentsOutline({
  nodes,
  entry,
  onCopyLink,
  onJump,
}: {
  nodes: OutlineNode[];
  entry: KnowledgeEntryDocument;
  onCopyLink?: ((uri: string, label: string) => void) | undefined;
  onJump: (heading: KnowledgeEntryHeading) => void;
}) {
  return (
    <CollapsibleSection
      title="Contents"
      storageKey={`knowledge.collapse.${entry.id}.contents`}
    >
      <nav aria-label="Contents">
        <OutlineList
          nodes={nodes}
          entry={entry}
          onCopyLink={onCopyLink}
          onJump={onJump}
          depth={0}
        />
      </nav>
    </CollapsibleSection>
  );
}

function OutlineList({
  nodes,
  entry,
  onCopyLink,
  onJump,
  depth,
}: {
  nodes: OutlineNode[];
  entry: KnowledgeEntryDocument;
  onCopyLink?: ((uri: string, label: string) => void) | undefined;
  onJump: (heading: KnowledgeEntryHeading) => void;
  depth: number;
}) {
  return (
    <ul
      className={
        depth === 0
          ? "flex flex-col"
          : "ml-2 flex flex-col border-l border-line pl-2"
      }
    >
      {nodes.map((node, index) => (
        <li key={`${depth}-${index}-${node.heading.text}`}>
          <div className="group flex items-center gap-1">
            <button
              type="button"
              onClick={() => onJump(node.heading)}
              className={`min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left text-caption hover:text-accent ${depth === 0 ? "text-muted" : "text-faint"}`}
              title={`Jump to “${node.heading.text}”`}
            >
              {node.heading.text}
            </button>
            {onCopyLink ? (
              <button
                type="button"
                onClick={() =>
                  onCopyLink(
                    formatPaObjectLink({
                      objectType: "knowledge",
                      id: entry.id,
                      fragment: node.heading.text,
                    }),
                    node.heading.text,
                  )
                }
                className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                title={`Copy link to “${node.heading.text}”`}
                aria-label={`Copy link to section ${node.heading.text}`}
              >
                <Link2 size={12} />
              </button>
            ) : null}
          </div>
          {node.children.length > 0 ? (
            <OutlineList
              nodes={node.children}
              entry={entry}
              onCopyLink={onCopyLink}
              onJump={onJump}
              depth={depth + 1}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AssetsSection({
  assets,
  resolveAssetUrl,
}: {
  assets: KnowledgeEntryAsset[];
  resolveAssetUrl: (assetPath: string) => string;
}) {
  return (
    <section
      aria-label="Assets"
      className="flex flex-col gap-2 border-t border-line pt-4"
    >
      <div className="flex items-center gap-1.5 text-caption font-medium uppercase tracking-wide text-faint">
        <Paperclip size={12} /> Assets
      </div>
      <ul className="flex flex-col gap-1.5">
        {assets.map((asset) => (
          <li key={asset.path}>
            <a
              href={resolveAssetUrl(asset.path)}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 rounded-lg border border-line bg-panel/50 px-2.5 py-1.5 text-caption text-fg transition-colors hover:bg-panel"
              title={asset.title ?? asset.path}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-muted">
                {asset.isImage ? (
                  <ImageIcon size={13} />
                ) : (
                  <FileText size={13} />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {asset.title ?? asset.path}
              </span>
              {asset.sizeBytes != null ? (
                <span className="shrink-0 text-micro text-faint">
                  {formatBytes(asset.sizeBytes)}
                </span>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InvalidEntry({
  back,
  headerActions,
  resource,
  refreshing,
}: {
  back?: PageHeaderBack | undefined;
  headerActions?: ReactNode | undefined;
  resource: Extract<KnowledgeEntryResponse, { kind: "invalid" }>;
  refreshing: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <PageHeader
        back={back}
        icon={<AlertTriangle size={16} />}
        iconTone="accent"
        title={resource.slug || "Invalid entry"}
        subtitle={resource.folder}
        actions={
          <>
            {headerActions}
            <HeaderActions refreshing={refreshing} />
          </>
        }
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-body text-danger">
            <div className="font-medium">This entry could not be parsed.</div>
            <p className="mt-1 break-words text-caption">{resource.error}</p>
          </div>
          {resource.markdown != null ? (
            <div className="min-w-0">
              <div className="mb-1 text-caption font-medium uppercase tracking-wide text-faint">
                Raw source
              </div>
              <pre className="overflow-x-auto rounded-xl border border-line bg-panel/60 px-3 py-2 text-caption text-muted">
                <code>{resource.markdown}</code>
              </pre>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/**
 * The header's trailing slot: the surface's own controls, preceded by the
 * refresh marker when a same-entry refetch is running. Renders nothing at all
 * when there is neither, so the header row keeps its shape.
 */
function HeaderActions({ refreshing }: { refreshing: boolean }) {
  if (!refreshing) return null;
  return (
    <div className="flex items-center gap-1">
      <RefreshIndicator label="Refreshing entry" />
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
