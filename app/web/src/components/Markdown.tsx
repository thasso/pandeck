import {
  Children,
  createContext,
  isValidElement,
  lazy,
  memo,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react";
import type React from "react";
import {
  documentTargetHref,
  resolveDocumentReference,
  type DocumentSourceContext,
  type DocumentTarget,
} from "@assistant/shared/documentTargets";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  fallbackPaObjectResolution,
  findPaObjectLinkUris,
  formatPaObjectLink,
  paObjectKey,
  parsePaObjectLink,
  type PaObjectLinkResolution,
} from "@assistant/shared/objectLinks";
import { sessionPath } from "../lib/sessionRoutes.ts";
import {
  directFileApiPath,
  isDocumentRelativeUrl,
  resolveDocumentRelative,
} from "../lib/servedFiles.ts";
import { resolveInternalDocumentTarget } from "../lib/documentTargets.ts";
import { forwardsLoopbackLinks } from "../lib/nativeShell.ts";
import {
  isPlainPrimaryClick,
  parseLoopbackLink,
} from "../lib/portForwardLinks.ts";
import { openForwardedLink } from "../lib/portForwards.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";

import {
  pushDocumentEntryAndAnnounce,
  pushEntryAndAnnounce,
} from "../lib/historyNav.ts";
import { fileViewerPath } from "../hooks/useSessionRouting.ts";
import { InlineDocumentEmbed } from "./InlineDocumentEmbed.tsx";

const CodeBlock = lazy(() =>
  import("./ui/CodeBlock.tsx").then((module) => ({
    default: module.CodeBlock,
  })),
);
const ChartBlock = lazy(() =>
  import("./ui/ChartBlock.tsx").then((module) => ({
    default: module.ChartBlock,
  })),
);

export interface MarkdownSessionReference {
  id: string;
  title?: string;
}

export interface MarkdownFileReference {
  path: string;
}

export type MarkdownPaObjectReference = PaObjectLinkResolution;

interface MarkdownProps {
  text: string;
  sessionReferences?: MarkdownSessionReference[];
  changedFiles?: MarkdownFileReference[];
  paObjectReferences?: MarkdownPaObjectReference[];
  onOpenSession?: ((id: string) => void) | undefined;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  /**
   * Optional resolver for relative link/image URLs (e.g. KB entry-local
   * `assets/...` paths). Return an absolute URL to use it, or null/undefined to
   * fall back to the default URL transform. `pa://` links are handled first and
   * never reach this hook.
   */
  onResolveUrl?: (url: string) => string | null | undefined;
  /**
   * Absolute directory of the document being rendered. Set it when the text
   * came from a FILE (the `/files/...` viewer): a relative image then loads
   * from beside that file and a relative link opens the viewer on it, as a
   * browser would resolve them. `onResolveUrl` is the hook for a caller whose
   * relative references are not host paths (the KB's entry-local assets).
   */
  documentDirectory?: string;
  /** Typed source identity used to keep relative document links in-app. */
  documentTarget?: DocumentSourceContext;
  /** Stamp rendered blocks with their 1-based Markdown source line range. */
  sourcePositions?: boolean;
  /**
   * `compact` renders the same prose one size down, for text that sits INSIDE
   * another surface rather than owning the column — a comment under a diff
   * line, in a thread card, in a sheet.
   */
  density?: "prose" | "compact";
  /**
   * `breakout` lets a wide table use the chat pane beyond the prose column.
   * Its scroll viewport remains bounded by the pane; other Markdown blocks keep
   * their normal line length.
   */
  tableLayout?: "contained" | "breakout";
}

// Raw HTML in Markdown is parsed (rehype-raw) then sanitized (rehype-sanitize)
// so model/agent/user-authored content can use inline HTML (e.g. the history
// diff's <ins>/<del> marks) without opening an XSS hole: scripts, event
// handlers, and unknown-scheme URLs are stripped. We only widen the GitHub
// default schema to keep the app's own internal link schemes working.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: [
      ...(defaultSchema.protocols?.href ?? []),
      "pi-session",
      "pi-workspace-file",
      "pa",
    ],
  },
};
const REHYPE_PLUGINS = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]] as const;

// KaTeX renders to MathML alone: no stylesheet and no webfonts to host, so
// `index.css` keeps sole ownership of typography and the chunk stays JS-only.
// Every browser this app runs in, both Tauri webviews included, renders MathML
// natively. Moving to KaTeX's HTML output is this flag plus its CSS and fonts.
// `maxSize` caps the em size a formula may ASK for. KaTeX leaves it at
// `Infinity`, so `\rule{999999em}{999999em}` in any message renders a box that
// swallows the transcript — every message here is untrusted text. Legitimate
// sizes are tiny (a `\rule` fraction bar is well under 1em), so 10 bounds the
// damage without reaching anything real. `trust` (false) already refuses
// `\includegraphics`, `\href` and raw HTML commands, and `maxExpand` (1000)
// bounds macro expansion; both defaults are what we want.
const KATEX_OPTIONS = {
  output: "mathml",
  throwOnError: false,
  maxSize: 10,
} as const;

// Inline math needs TWO dollars (`$$W = H/2$$` inside a sentence); a lone `$`
// is never math. With single-dollar text math on, "it costs $5, on sale for $3"
// renders its middle as a formula — a live hazard in an assistant that talks
// about money. Requiring `$$` gives both forms from one delimiter with no
// ambiguity: alone in a paragraph it is a display block, in a sentence inline.
const REMARK_MATH_OPTIONS = { singleDollarTextMath: false } as const;

/**
 * KaTeX is 266 KB minified — several times the rest of this renderer — and most
 * messages hold no math, so it loads on FIRST SIGHT of a formula instead of
 * with this module (the same reason `CodeBlock` and `ChartBlock` are lazy).
 *
 * `remark-math` stays STATIC at 13 KB: it is what turns `$$…$$` into the marked
 * elements, and having it in the pipeline is also what makes detection exact.
 * Sniffing the raw text for `$` would fire on ordinary chat prose ("$20 vs
 * $35") and pull the chunk down for nothing.
 */
let mathKatexPlugin: readonly unknown[] | null = null;
let mathLoad: Promise<void> | null = null;
const mathLoadWaiters = new Set<() => void>();

/** Starts the load if it is not running, and returns an unsubscribe. */
function loadMathKatexPlugin(onLoaded: () => void): () => void {
  if (mathKatexPlugin) {
    onLoaded();
    return NO_UNSUBSCRIBE;
  }
  // Deleted again by the caller's cleanup: the effect below re-runs on every
  // commit, so a waiter that only went in would pile up one closure per commit
  // of a streaming message and retain unmounted components until the import
  // settled — or forever, if it never did.
  mathLoadWaiters.add(onLoaded);
  mathLoad ??= import("rehype-katex")
    .then(({ default: rehypeKatex }) => {
      // Built once and thereafter reused BY IDENTITY: a fresh plugin per render
      // would re-run the whole parse → sanitize → element-tree pipeline.
      mathKatexPlugin = [rehypeKatex, KATEX_OPTIONS];
      // Notified HERE, on success only. Doing this in a `finally` would tell
      // every mounted formula the load had settled when it had in fact failed,
      // and then clear them — so a message still on screen during a failed
      // attempt would stay raw source forever, even once a later formula's
      // retry succeeded. On failure the waiters stay put for that retry.
      for (const waiter of [...mathLoadWaiters]) waiter();
      mathLoadWaiters.clear();
    })
    .catch(() => {
      // Formulas keep showing their LaTeX source; the next one to appear
      // retries. A failed import must not wedge the renderer for the session.
      mathLoad = null;
    });
  return () => mathLoadWaiters.delete(onLoaded);
}

const NO_UNSUBSCRIBE = () => {};

const NO_SESSION_REFERENCES: MarkdownSessionReference[] = [];
const NO_CHANGED_FILES: MarkdownFileReference[] = [];
const NO_PA_OBJECT_REFERENCES: MarkdownPaObjectReference[] = [];

const SESSION_ID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SESSION_HREF_PREFIX = "pi-session://";
const WORKSPACE_FILE_HREF_PREFIX = "pi-workspace-file://";
const FILE_BOUNDARY_PATTERN = /[A-Za-z0-9_./-]/;

/**
 * @component Markdown
 * @purpose Shared Markdown renderer for chat prose and rich cards, with GFM, code highlighting, artifact cards, session-id autolinks, changed-file links, and title-inferred pa:// object links.
 * @useWhen Rendering user/assistant message text or Markdown summaries where chat-native links and code styling should apply.
 * @avoidWhen The content is not trusted as Markdown or needs a custom non-prose layout.
 * @intent Keep persisted text unchanged while enriching known app object references with current navigation affordances.
 */
export const Markdown = memo(function Markdown({
  text,
  // Shared empties, not `= []`: a fresh array per render would re-derive the
  // lookups and the remark plugins built from them, which rebuilds the whole
  // element tree for every caller that omits these (a file preview, a card).
  sessionReferences = NO_SESSION_REFERENCES,
  changedFiles = NO_CHANGED_FILES,
  paObjectReferences = NO_PA_OBJECT_REFERENCES,
  onOpenSession,
  onOpenChangedFile,
  onOpenPaObject,
  onResolveUrl,
  documentDirectory,
  documentTarget,
  sourcePositions = false,
  density = "prose",
  tableLayout = "contained",
}: MarkdownProps) {
  const sessionsById = useMemo(() => {
    const map = new Map<string, MarkdownSessionReference>();
    for (const session of sessionReferences)
      map.set(session.id.toLowerCase(), session);
    return map;
  }, [sessionReferences]);

  const filesByPath = useMemo(() => {
    const map = new Map<string, MarkdownFileReference>();
    for (const file of changedFiles) map.set(file.path, file);
    return map;
  }, [changedFiles]);

  const sortedFiles = useMemo(
    () =>
      Array.from(filesByPath.values()).sort(
        (a, b) => b.path.length - a.path.length,
      ),
    [filesByPath],
  );

  const paObjectsByUri = useMemo(() => {
    const map = new Map<string, PaObjectLinkResolution>();
    for (const ref of paObjectReferences) {
      map.set(ref.uri, ref);
      map.set(paObjectKey(ref), ref);
      try {
        map.set(
          formatPaObjectLink({
            objectType: ref.objectType,
            id: ref.id,
            ...(ref.query !== undefined ? { query: ref.query } : {}),
            ...(ref.fragment !== undefined ? { fragment: ref.fragment } : {}),
          }),
          ref,
        );
      } catch {
        // Ignore malformed refs from older callers; the direct uri key remains.
      }
    }
    return map;
  }, [paObjectReferences]);

  // Written during the parse below, read by the effect after it: whether THIS
  // text held a formula. A ref, not state, because the answer is produced while
  // the tree is built — setting state there would be a render-phase update from
  // a child.
  const sawMath = useRef(false);
  const [mathReady, setMathReady] = useState(() => mathKatexPlugin !== null);
  // Stable, so the subscribe/unsubscribe pair below moves ONE identity in and
  // out of the waiter set per commit instead of churning it.
  const onMathLoaded = useCallback(() => {
    if (mathKatexPlugin) setMathReady(true);
  }, []);

  const remarkPlugins = useMemo(
    () => [
      remarkGfm,
      [remarkMath, REMARK_MATH_OPTIONS],
      remarkPaObjectLinks(),
      remarkChatReferences(sessionsById, sortedFiles),
    ],
    [sessionsById, sortedFiles],
  );

  // The handlers are held in a ref and reached through fixed wrappers: a caller
  // that passes an inline arrow (most do) would otherwise change the context on
  // every one of ITS renders, re-rendering every link in every rendered message
  // for a function that does the same thing.
  const handlersRef = useRef<MarkdownHandlers>({});
  handlersRef.current = {
    ...(onOpenSession !== undefined ? { onOpenSession } : {}),
    ...(onOpenChangedFile !== undefined ? { onOpenChangedFile } : {}),
    ...(onOpenPaObject !== undefined ? { onOpenPaObject } : {}),
  };
  const handlers = useMemo<MarkdownHandlers>(
    () => ({
      onOpenSession: (id) => handlersRef.current.onOpenSession?.(id),
      onOpenChangedFile: (path) =>
        handlersRef.current.onOpenChangedFile?.(path),
      onOpenPaObject: (link) => handlersRef.current.onOpenPaObject?.(link),
    }),
    [],
  );
  const renderContext = useMemo<MarkdownRenderValue>(
    () => ({
      sourcePositions,
      sessionsById,
      filesByPath,
      paObjectsByUri,
      handlers,
      tableLayout,
      ...(documentDirectory !== undefined ? { documentDirectory } : {}),
      ...(documentTarget !== undefined ? { documentTarget } : {}),
    }),
    [
      sourcePositions,
      sessionsById,
      filesByPath,
      paObjectsByUri,
      handlers,
      documentDirectory,
      documentTarget,
      tableLayout,
    ],
  );

  // NOT held behind a ref, unlike the click handlers above: a handler runs when
  // the reader acts, so the latest one is always the one that fires, but a URL
  // is resolved WHILE THE TREE IS BUILT and then frozen into an `href`/`src`.
  // A resolver that answers differently (the KB's entry-local assets, a file
  // preview's worktree and path) therefore has to rebuild the tree, or the
  // rendered image is the previous entry's.
  const urlTransform = useCallback(
    (url: string) => {
      if (parsePaObjectLink(url)) return url;
      const resolved = onResolveUrl?.(url);
      return resolved != null ? resolved : defaultUrlTransform(url);
    },
    [onResolveUrl],
  );

  // Runs after the parse that sets `sawMath`, so the chunk is requested only
  // once a formula has actually been seen. Kicked on every commit rather than
  // on `text` alone: a streaming reply grows through many commits and the math
  // may arrive in any of them. `loadMathKatexPlugin` is idempotent, so the
  // repeat calls after the first cost nothing.
  useEffect(() => {
    if (!sawMath.current || mathReady) return;
    return loadMathKatexPlugin(onMathLoaded);
  });

  // raw → sanitize → detect → KaTeX. The detector is per-component (it writes
  // this component's ref), so unlike `MARKDOWN_COMPONENTS` this array cannot be
  // module scope; memoizing it on `mathReady` alone still gives one identity per
  // mount, which is what keeps the pipeline from re-running on every render. It
  // changes exactly once: when KaTeX lands.
  const rehypePlugins = useMemo(
    () => [
      ...REHYPE_PLUGINS,
      rehypeFlagMath(sawMath),
      ...(mathReady && mathKatexPlugin ? [mathKatexPlugin] : []),
    ],
    [mathReady],
  );

  // The parse → sanitize → element-tree pipeline runs only when what it reads
  // changed: the text, the reference-bearing remark plugins, and the resolver.
  // `MARKDOWN_COMPONENTS` is fixed, so everything else about this render (a new
  // handler identity, a parent re-render) reaches the rendered links through the
  // context instead of rebuilding the tree. A caller that passes `onResolveUrl`
  // owns its identity for the same reason every other prop here is owned.
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={remarkPlugins as never}
        rehypePlugins={rehypePlugins as never}
        urlTransform={urlTransform}
        components={MARKDOWN_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    ),
    [remarkPlugins, rehypePlugins, text, urlTransform],
  );

  return (
    <div className={density === "compact" ? "prose prose-compact" : "prose"}>
      <MarkdownRenderContext.Provider value={renderContext}>
        {rendered}
      </MarkdownRenderContext.Provider>
    </div>
  );
});

interface MarkdownHandlers {
  onOpenSession?: (id: string) => void;
  onOpenChangedFile?: (path: string) => void;
  onOpenPaObject?: (link: PaObjectLinkResolution) => void;
}

interface MarkdownRenderValue {
  sourcePositions: boolean;
  sessionsById: Map<string, MarkdownSessionReference>;
  filesByPath: Map<string, MarkdownFileReference>;
  paObjectsByUri: Map<string, PaObjectLinkResolution>;
  handlers: MarkdownHandlers;
  /** See `MarkdownProps.documentDirectory`. */
  documentDirectory?: string;
  documentTarget?: DocumentSourceContext;
  tableLayout: "contained" | "breakout";
}

const EMPTY_RENDER_CONTEXT: MarkdownRenderValue = {
  sourcePositions: false,
  sessionsById: new Map(),
  filesByPath: new Map(),
  paObjectsByUri: new Map(),
  handlers: {},
  tableLayout: "contained",
};

const MarkdownRenderContext = createContext(EMPTY_RENDER_CONTEXT);

/**
 * Every mapped element type, defined ONCE at module scope.
 *
 * react-markdown renders each node as `createElement(components[tag], …)`, so a
 * `components` map rebuilt per render hands React a new element TYPE for every
 * node — which is not a re-render but an unmount and remount: fresh DOM nodes,
 * so a `<pre>` loses the reader's horizontal scroll, a selection collapses, and
 * every lazily mounted `CodeBlock` re-runs Shiki. Keeping the types fixed is
 * what makes a Markdown re-render a reconciliation instead of a rebuild; the
 * per-instance data these read comes from {@link MarkdownRenderContext}.
 */
function positioned<Tag extends keyof React.JSX.IntrinsicElements>(tag: Tag) {
  return function PositionedElement({
    node,
    ...props
  }: React.JSX.IntrinsicElements[Tag] & ExtraProps) {
    const { sourcePositions } = useContext(MarkdownRenderContext);
    const Element = tag as ElementType;
    return (
      <Element
        {...sourcePositionAttributes(node, sourcePositions)}
        {...props}
      />
    );
  };
}

function MarkdownTable({
  node,
  ...props
}: React.JSX.IntrinsicElements["table"] & ExtraProps) {
  const { sourcePositions, tableLayout } = useContext(MarkdownRenderContext);
  return (
    <div
      className={
        tableLayout === "breakout"
          ? "markdown-table-scroll markdown-table-breakout"
          : "markdown-table-scroll"
      }
      // An unconditional tab stop gives Safari keyboard users the same access
      // Chromium gives overflowing regions natively. A small table may not need
      // to scroll, but avoiding per-table observers keeps this wrapper stable.
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
    >
      <table {...sourcePositionAttributes(node, sourcePositions)} {...props} />
    </div>
  );
}

function MarkdownAnchor({
  node: _node,
  href,
  children,
  ...props
}: React.JSX.IntrinsicElements["a"] & ExtraProps) {
  const {
    sessionsById,
    paObjectsByUri,
    handlers,
    documentDirectory,
    documentTarget,
  } = useContext(MarkdownRenderContext);
  if (
    !href ||
    href === "..." ||
    href === "…" ||
    href === "#" ||
    href.toLowerCase() === "todo"
  ) {
    return <>{children}</>;
  }
  // `[![alt](image)](target)` keeps the link the author wrote: the picture
  // renders INSIDE that one anchor, stripped of the standalone embed's own
  // controls, so the result is never a nested anchor or a button inside a link.
  const linkedImage = singleImageChild(children);
  const content = linkedImage ? (
    <LinkedMarkdownImage src={linkedImage.src} alt={linkedImage.alt} />
  ) : (
    children
  );
  // A picture with no alt text leaves the link unnamed; the destination is the
  // only honest name for it. An authored attribute still wins.
  const anchorProps =
    linkedImage && !linkedImage.alt
      ? { "aria-label": `Open ${linkTargetLabel(href)}`, ...props }
      : props;
  const sessionRef = parseSessionHref(href);
  if (sessionRef) {
    const session = sessionsById.get(sessionRef.id.toLowerCase()) ?? sessionRef;
    const title = session.title?.trim();
    return (
      <a
        href={sessionPath(session.id)}
        title={title ? `${title} — ${session.id}` : session.id}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          handlers.onOpenSession?.(session.id);
        }}
        {...anchorProps}
      >
        {title && title !== session.id ? (
          <>
            {title} <span className="font-mono text-faint">({session.id})</span>
          </>
        ) : (
          <span className="font-mono">{session.id}</span>
        )}
      </a>
    );
  }
  const filePath = parseWorkspaceFileHref(href);
  if (filePath) {
    return (
      <ChangedFileLink
        path={filePath}
        onOpenChangedFile={handlers.onOpenChangedFile}
        props={anchorProps}
      >
        {content}
      </ChangedFileLink>
    );
  }
  const internalTarget =
    resolveInternalDocumentTarget(href) ??
    (documentTarget && (isDocumentRelativeUrl(href) || href.startsWith("#"))
      ? resolveDocumentReference(documentTarget, href)
      : null);
  if (internalTarget) {
    const targetHref = documentTargetHref(internalTarget);
    return (
      <a
        href={targetHref}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          pushDocumentEntryAndAnnounce(targetHref);
        }}
        {...anchorProps}
      >
        {content}
      </a>
    );
  }
  const paObject = resolveMarkdownPaObject(href, paObjectsByUri);
  if (paObject) {
    return (
      <PaObjectLink
        link={paObject}
        href={href}
        onOpenPaObject={handlers.onOpenPaObject}
        props={anchorProps}
      >
        {content}
      </PaObjectLink>
    );
  }
  if (documentDirectory && isDocumentRelativeUrl(href)) {
    // A document's own sibling reference: open it in the viewer rather than
    // resolving against the app's route, which is not where the file lives.
    const viewerHref = fileViewerPath(
      resolveDocumentRelative(documentDirectory, href),
    );
    return (
      <a
        href={viewerHref}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          pushEntryAndAnnounce(viewerHref);
        }}
        {...anchorProps}
      >
        {content}
      </a>
    );
  }
  return (
    <a
      target="_blank"
      rel="noreferrer noopener"
      href={href}
      onClick={onExternalLinkClick}
      {...anchorProps}
    >
      {content}
    </a>
  );
}

/**
 * A plain click on a `localhost:PORT` link, in the macOS shell with the app
 * served from elsewhere, is forwarded to the server's port and opened in the
 * OS browser (`docs/port-forwarding.md`). Everything else — a modified click,
 * any other link, a browser, an app served from loopback — keeps the anchor's
 * own behaviour. Module-level so every external anchor shares one handler.
 */
function onExternalLinkClick(event: React.MouseEvent<HTMLAnchorElement>) {
  if (!isPlainPrimaryClick(event)) return;
  // The attribute, not the resolved `href`: only a link WRITTEN as an absolute
  // loopback URL qualifies, never one that merely resolves to it.
  const link = parseLoopbackLink(
    event.currentTarget.getAttribute("href") ?? "",
  );
  if (!link || !forwardsLoopbackLinks()) return;
  event.preventDefault();
  void openForwardedLink(link);
}

/** Where an authored image's bytes come from, after the origin check. */
type MarkdownImageSource = { target: DocumentTarget } | { src: string };

function resolveMarkdownImageSource(
  src: string | undefined,
  context: {
    documentDirectory?: string | undefined;
    documentTarget?: DocumentSourceContext | undefined;
  },
): MarkdownImageSource | null {
  if (!src) return null;
  const internalTarget =
    resolveInternalDocumentTarget(src) ??
    (context.documentTarget && isDocumentRelativeUrl(src)
      ? resolveDocumentReference(context.documentTarget, src)
      : null);
  if (internalTarget) return { target: internalTarget };
  if (context.documentDirectory && isDocumentRelativeUrl(src)) {
    // Inside a rendered document an image is an image, not a card: the reader
    // opened the document to read it, and the file's own path is already in the
    // viewer's header.
    return {
      src: artifactHttpUrl(
        directFileApiPath(
          resolveDocumentRelative(context.documentDirectory, src),
        ),
      ),
    };
  }
  return { src };
}

/**
 * A Markdown image is explicit embed intent. A typed internal target becomes a
 * lazy inline image/media/HTML presentation; links and tool-output cards remain
 * distinct. Foreign images are left as authored after origin checking.
 */
function MarkdownImage({
  node: _node,
  src,
  alt,
  ...props
}: React.JSX.IntrinsicElements["img"] & ExtraProps) {
  const { documentDirectory, documentTarget } = useContext(
    MarkdownRenderContext,
  );
  const resolved = resolveMarkdownImageSource(
    typeof src === "string" ? src : undefined,
    { documentDirectory, documentTarget },
  );
  if (resolved && "target" in resolved) {
    return (
      <InlineDocumentEmbed target={resolved.target} label={alt || undefined} />
    );
  }
  return <img src={resolved?.src ?? src} alt={alt ?? ""} {...props} />;
}

/**
 * The picture inside `[![alt](image)](target)`. Same sources and same origin
 * check as a standalone embed, and nothing interactive: the surrounding anchor
 * is the only affordance, and an internal target that is not an image (media,
 * HTML, a PDF) degrades to that link's text rather than smuggling a control
 * into it.
 */
function LinkedMarkdownImage({
  src,
  alt,
}: {
  src?: string | undefined;
  alt?: string | undefined;
}) {
  const { documentDirectory, documentTarget } = useContext(
    MarkdownRenderContext,
  );
  const resolved = resolveMarkdownImageSource(src, {
    documentDirectory,
    documentTarget,
  });
  if (resolved && "target" in resolved) {
    return (
      <InlineDocumentEmbed
        target={resolved.target}
        label={alt || undefined}
        insideLink
      />
    );
  }
  return <img src={resolved?.src ?? src} alt={alt ?? ""} />;
}

/** The `![alt](image)` an anchor wraps, if that is all it wraps. */
function singleImageChild(
  children: ReactNode,
): { src?: string | undefined; alt?: string | undefined } | null {
  const childList = Children.toArray(children);
  const only = childList[0];
  if (childList.length !== 1 || !isValidElement(only)) return null;
  if (only.type !== MarkdownImage) return null;
  const imageProps = only.props as { src?: unknown; alt?: unknown };
  return {
    src: typeof imageProps.src === "string" ? imageProps.src : undefined,
    alt: typeof imageProps.alt === "string" ? imageProps.alt : undefined,
  };
}

/** A short name for a link destination, for a picture that carries no alt. */
function linkTargetLabel(href: string): string {
  const withoutQuery = href.split(/[?#]/)[0] ?? href;
  const segment = withoutQuery.split("/").filter(Boolean).pop() ?? href;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function MarkdownCode({
  node: _node,
  className,
  children,
  ...props
}: React.JSX.IntrinsicElements["code"] & ExtraProps) {
  const { sourcePositions, filesByPath, handlers } = useContext(
    MarkdownRenderContext,
  );
  const languageMatch = /language-(\w+)/.exec(className ?? "");
  const text = String(children ?? "");
  // Fenced code (has a `language-*` class) or any multiline code is a
  // block: route it through the shared Shiki `CodeBlock`. Everything
  // else is inline code.
  // A ```chart``` fence renders a lazy Chart.js chart (Task 139),
  // degrading to a plain data block on a malformed/oversized spec.
  if (languageMatch?.[1] === "chart") {
    const spec = text.replace(/\n$/, "");
    return (
      <div {...sourcePositionAttributes(_node, sourcePositions)}>
        <Suspense fallback={<PlainCodeBlock code={spec} />}>
          <ChartBlock spec={spec} />
        </Suspense>
      </div>
    );
  }
  // `remark-math` marks every formula as `language-math`, and `rehype-katex`
  // REPLACES the element before it reaches this map — so this branch is only
  // ever the placeholder shown while that lazy chunk is still in flight. It
  // renders the LaTeX source as plain text on purpose: sending it to `CodeBlock`
  // would start a Shiki highlight for a language that does not exist, and the
  // block chrome would then disappear again a moment later.
  if (languageMatch?.[1] === "math") {
    return (
      <span className="whitespace-pre-wrap">{text.replace(/\n$/, "")}</span>
    );
  }
  if (languageMatch || text.includes("\n")) {
    return (
      <div {...sourcePositionAttributes(_node, sourcePositions)}>
        <Suspense fallback={<PlainCodeBlock code={text.replace(/\n$/, "")} />}>
          <CodeBlock
            code={text.replace(/\n$/, "")}
            language={languageMatch?.[1]}
            copyable
          />
        </Suspense>
      </div>
    );
  }
  const filePath = singleTextChild(children).trim();
  if (filePath && filesByPath.has(filePath)) {
    return (
      <ChangedFileCodeLink
        path={filePath}
        onOpenChangedFile={handlers.onOpenChangedFile}
      >
        {children}
      </ChangedFileCodeLink>
    );
  }
  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: positioned("p"),
  h1: positioned("h1"),
  h2: positioned("h2"),
  h3: positioned("h3"),
  h4: positioned("h4"),
  h5: positioned("h5"),
  h6: positioned("h6"),
  li: positioned("li"),
  blockquote: positioned("blockquote"),
  table: MarkdownTable,
  tr: positioned("tr"),
  hr: positioned("hr"),
  // Fenced code is rendered by `CodeBlock` (the one shared Shiki
  // highlighter), which renders its own container, so unwrap the `pre`.
  pre: ({ children }: React.JSX.IntrinsicElements["pre"] & ExtraProps) => (
    <>{children}</>
  ),
  a: MarkdownAnchor,
  img: MarkdownImage,
  code: MarkdownCode,
};

interface PositionedMarkdownNode {
  position?: { start?: { line?: number }; end?: { line?: number } };
}

function sourcePositionAttributes(
  node: unknown,
  enabled: boolean,
): Record<string, number> {
  if (!enabled || !node || typeof node !== "object") return {};
  const position = (node as PositionedMarkdownNode).position;
  const start = position?.start?.line;
  const end = position?.end?.line;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return {};
  return { "data-source-line-start": start!, "data-source-line-end": end! };
}

function PlainCodeBlock({ code }: { code: string }) {
  return (
    <pre className="shiki overflow-x-auto whitespace-pre">
      <code>{code}</code>
    </pre>
  );
}

function PaObjectLink({
  link,
  href,
  onOpenPaObject,
  props = {},
  children,
}: {
  link: PaObjectLinkResolution;
  href: string;
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  props?: Record<string, unknown>;
  children: ReactNode;
}) {
  const text = singleTextChild(children).trim();
  const inferred = !text || text === href || text === link.uri;
  const broken = link.existence === "missing";
  return (
    <a
      href={broken ? "#" : link.href}
      title={
        broken
          ? `Unresolved ${link.typeLabel.toLowerCase()} link: ${link.id}`
          : `${link.typeLabel}: ${link.title}${link.detail ? ` (${link.detail})` : ""}`
      }
      className={broken ? "text-danger decoration-dotted" : undefined}
      aria-invalid={broken ? true : undefined}
      onClick={(event) => {
        if (
          broken ||
          !onOpenPaObject ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpenPaObject(link);
      }}
      {...props}
    >
      {inferred ? link.title : children}
      {/* Live state the label cannot carry, e.g. whether a linked approval
          card is still waiting — so "approve this" reads as done once it is. */}
      {!broken && link.detail ? (
        <span className="text-muted"> · {link.detail}</span>
      ) : null}
    </a>
  );
}

function ChangedFileLink({
  path,
  onOpenChangedFile,
  props = {},
  children,
}: {
  path: string;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  props?: Record<string, unknown>;
  children: ReactNode;
}) {
  return (
    <a
      href={workspaceFilePathHref(path)}
      title={`Open workspace file ${path}`}
      onClick={(event) => {
        if (
          !onOpenChangedFile ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpenChangedFile(path);
      }}
      {...props}
    >
      {children}
    </a>
  );
}

function ChangedFileCodeLink({
  path,
  onOpenChangedFile,
  children,
}: {
  path: string;
  onOpenChangedFile?: ((path: string) => void) | undefined;
  children: ReactNode;
}) {
  return (
    <a
      href={workspaceFilePathHref(path)}
      title={`Open workspace file ${path}`}
      className="rounded-[5px] border border-line bg-raised px-[0.34em] py-[0.08em] font-mono"
      onClick={(event) => {
        if (
          !onOpenChangedFile ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpenChangedFile(path);
      }}
    >
      {children}
    </a>
  );
}

function singleTextChild(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children) && children.length === 1)
    return singleTextChild(children[0]);
  return "";
}

// Session autolinks are addressed by our session id alone (no kind): the host is
// a fixed `session` and the id is the path. The renderer resolves the id to a
// known reference (for its title/icon) when one is in `sessionReferences`.
function sessionHref(id: string): string {
  return `${SESSION_HREF_PREFIX}session/${encodeURIComponent(id)}`;
}

function parseSessionHref(href: string): MarkdownSessionReference | null {
  if (!href.startsWith(SESSION_HREF_PREFIX)) return null;
  try {
    const url = new URL(href);
    const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return id ? { id } : null;
  } catch {
    return null;
  }
}

function workspaceFileHref(path: string): string {
  return `${WORKSPACE_FILE_HREF_PREFIX}${encodeURIComponent(path)}`;
}

function workspaceFilePathHref(path: string): string {
  return `#workspace-diff:${encodeURIComponent(path)}`;
}

function resolveMarkdownPaObject(
  href: string,
  references: Map<string, PaObjectLinkResolution>,
): PaObjectLinkResolution | null {
  const parsed = parsePaObjectLink(href);
  if (!parsed) return null;
  let canonical = href;
  try {
    canonical = formatPaObjectLink({
      objectType: parsed.objectType,
      id: parsed.id,
      ...(parsed.query !== undefined ? { query: parsed.query } : {}),
      ...(parsed.fragment !== undefined ? { fragment: parsed.fragment } : {}),
    });
  } catch {
    // Keep the direct href lookup/fallback below.
  }
  const fallback = fallbackPaObjectResolution(parsed);
  const exact = references.get(href) ?? references.get(canonical);
  if (exact) return exact;
  const idOnly = references.get(paObjectKey(parsed));
  return idOnly ? { ...idOnly, ...parsed, href: fallback.href } : fallback;
}

function parseWorkspaceFileHref(href: string): string | null {
  if (!href.startsWith(WORKSPACE_FILE_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(WORKSPACE_FILE_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Records whether this message holds a formula, so the component can fetch
 * KaTeX for it and for no other. It only reads the tree.
 *
 * Deliberately a REHYPE plugin, running after `rehype-raw` and
 * `rehype-sanitize`: it then sees exactly the tree `rehype-katex` will see, so
 * the two cannot disagree about what is math. Detecting in remark instead meant
 * three separate cases (`inlineMath`, a ```math fence, raw HTML) and still got
 * the last one wrong — raw HTML is one opaque string there, so
 * `<code class="language&#x2d;math">` hid from a substring match while
 * `rehype-raw` decoded it into a real `language-math` class that KaTeX rendered.
 * The same input then rendered as source or as math depending on whether an
 * unrelated earlier message had already pulled the chunk in.
 */
function rehypeFlagMath(sawMath: { current: boolean }) {
  return () => (tree: any) => {
    sawMath.current = hastHasMath(tree);
  };
}

/** The classes `rehype-katex` itself renders; kept in step with it on purpose. */
const MATH_CLASS_NAMES = ["language-math", "math-display", "math-inline"];

function hastHasMath(node: any): boolean {
  if (!node) return false;
  const classes = node.properties?.className;
  if (
    Array.isArray(classes) &&
    classes.some((name: unknown) => MATH_CLASS_NAMES.includes(name as string))
  )
    return true;
  if (!Array.isArray(node.children)) return false;
  return node.children.some((child: any) => hastHasMath(child));
}

function remarkPaObjectLinks() {
  return () => (tree: any) => {
    linkPaObjectBareText(tree);
  };
}

function linkPaObjectBareText(node: any): void {
  if (!node || !Array.isArray(node.children)) return;
  if (
    [
      "link",
      "linkReference",
      "definition",
      "code",
      "inlineCode",
      "html",
    ].includes(node.type)
  )
    return;

  node.children = node.children.flatMap((child: any) => {
    if (child?.type !== "text" || typeof child.value !== "string") {
      linkPaObjectBareText(child);
      return [child];
    }

    const parts: any[] = [];
    let lastIndex = 0;
    for (const raw of findPaObjectLinkUris(child.value)) {
      const matchIndex = child.value.indexOf(raw, lastIndex);
      if (matchIndex < 0) continue;
      if (matchIndex > lastIndex)
        parts.push({
          type: "text",
          value: child.value.slice(lastIndex, matchIndex),
        });
      parts.push({
        type: "link",
        url: raw,
        title: null,
        children: [{ type: "text", value: raw }],
      });
      lastIndex = matchIndex + raw.length;
    }
    if (parts.length === 0) return [child];
    if (lastIndex < child.value.length)
      parts.push({ type: "text", value: child.value.slice(lastIndex) });
    return parts;
  });
}

function remarkChatReferences(
  sessionsById: Map<string, MarkdownSessionReference>,
  sortedFiles: MarkdownFileReference[],
) {
  return () => (tree: any) => {
    if (sessionsById.size === 0 && sortedFiles.length === 0) return;
    linkChatReferences(tree, sessionsById, sortedFiles);
  };
}

function linkChatReferences(
  node: any,
  sessionsById: Map<string, MarkdownSessionReference>,
  sortedFiles: MarkdownFileReference[],
): void {
  if (!node || !Array.isArray(node.children)) return;
  if (
    [
      "link",
      "linkReference",
      "definition",
      "code",
      "inlineCode",
      "html",
    ].includes(node.type)
  )
    return;

  node.children = node.children.flatMap((child: any) => {
    if (child?.type !== "text" || typeof child.value !== "string") {
      linkChatReferences(child, sessionsById, sortedFiles);
      return [child];
    }

    const parts: any[] = [];
    let lastIndex = 0;
    for (const match of findReferenceMatches(
      child.value,
      sessionsById,
      sortedFiles,
    )) {
      if (match.index < lastIndex) continue;
      if (match.index > lastIndex)
        parts.push({
          type: "text",
          value: child.value.slice(lastIndex, match.index),
        });
      parts.push({
        type: "link",
        url: match.url,
        title: null,
        children: [{ type: "text", value: match.text }],
      });
      lastIndex = match.index + match.text.length;
    }
    if (parts.length === 0) return [child];
    if (lastIndex < child.value.length)
      parts.push({ type: "text", value: child.value.slice(lastIndex) });
    return parts;
  });
}

function findReferenceMatches(
  text: string,
  sessionsById: Map<string, MarkdownSessionReference>,
  sortedFiles: MarkdownFileReference[],
): Array<{ index: number; text: string; url: string; priority: number }> {
  const matches: Array<{
    index: number;
    text: string;
    url: string;
    priority: number;
  }> = [];

  for (const match of text.matchAll(SESSION_ID_PATTERN)) {
    const id = match[0];
    const session = sessionsById.get(id.toLowerCase());
    if (!session || match.index === undefined) continue;
    matches.push({
      index: match.index,
      text: id,
      url: sessionHref(session.id),
      priority: 1,
    });
  }

  for (const file of sortedFiles) {
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const index = text.indexOf(file.path, fromIndex);
      if (index === -1) break;
      fromIndex = index + file.path.length;
      if (!hasFileBoundary(text, index, file.path.length)) continue;
      matches.push({
        index,
        text: file.path,
        url: workspaceFileHref(file.path),
        priority: 2,
      });
    }
  }

  return matches.sort(
    (a, b) =>
      a.index - b.index ||
      b.text.length - a.text.length ||
      b.priority - a.priority,
  );
}

function hasFileBoundary(text: string, index: number, length: number): boolean {
  const before = index > 0 ? text[index - 1] : "";
  const after = index + length < text.length ? text[index + length] : "";
  return (
    (!before || !FILE_BOUNDARY_PATTERN.test(before)) &&
    (!after || !FILE_BOUNDARY_PATTERN.test(after))
  );
}
