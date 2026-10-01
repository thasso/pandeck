import {
  normalizeAnchorText,
  PREFIX_LEN,
  SUFFIX_LEN,
  type SelectorBundle,
} from "@assistant/shared/comments";

/**
 * Turn a browser `Range` into the stored `SelectorBundle` (`docs/comments.md`).
 *
 * `documentText` is the text the resolver will later search — the caller's
 * contract is that the root renders it 1:1, so a character offset into the
 * root's text content is the same offset into `documentText`. Where a surface
 * renders something else (Markdown source vs. rendered prose), it must map the
 * offsets itself before calling the reducer.
 *
 * The DOM walk is separated from the pure reducer on purpose: `lib/` tests run
 * DOM-free, so `bundleFromOffsets` is unit-tested here and the walk is covered
 * at component level.
 */
export function describeAnchor(
  range: Range,
  root: HTMLElement,
  documentText: string,
): SelectorBundle | null {
  if (
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  const start = offsetInRoot(root, range.startContainer, range.startOffset);
  const end = offsetInRoot(root, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return bundleFromOffsets(
    documentText,
    Math.min(start, end),
    Math.max(start, end),
  );
}

/**
 * Pure reducer: slice the quote and its surrounding context out of the RAW
 * document text. Stored text is never normalized — normalization is a
 * comparison step in the resolver only.
 */
export function bundleFromOffsets(
  documentText: string,
  start: number,
  end: number,
): SelectorBundle | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > documentText.length || start >= end) return null;
  const exact = documentText.slice(start, end);
  if (!normalizeAnchorText(exact)) return null;
  return {
    quote: {
      exact,
      prefix: documentText.slice(Math.max(0, start - PREFIX_LEN), start),
      suffix: documentText.slice(
        end,
        Math.min(documentText.length, end + SUFFIX_LEN),
      ),
    },
    position: { start, end },
  };
}

/**
 * Character offset of a range boundary within the root's text content, counting
 * text nodes in document order.
 */
export function offsetInRoot(
  root: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  const boundary = textBoundary(container, offset);
  if (!boundary) return null;
  let total = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === boundary.node) return total + boundary.offset;
    total += node.textContent?.length ?? 0;
  }
  return null;
}

/**
 * Normalize an element-anchored boundary (`container` is an element, `offset` a
 * child index) to a text node plus an offset inside it.
 */
function textBoundary(
  container: Node,
  offset: number,
): { node: Node; offset: number } | null {
  if (container.nodeType === Node.TEXT_NODE) return { node: container, offset };
  const children = container.childNodes;
  for (let i = offset; i < children.length; i++) {
    const first = firstTextNode(children[i]!);
    if (first) return { node: first, offset: 0 };
  }
  for (let i = offset - 1; i >= 0; i--) {
    const last = lastTextNode(children[i]!);
    if (last) return { node: last, offset: last.textContent?.length ?? 0 };
  }
  return null;
}

function firstTextNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node;
  for (const child of Array.from(node.childNodes)) {
    const found = firstTextNode(child);
    if (found) return found;
  }
  return null;
}

function lastTextNode(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node;
  const children = Array.from(node.childNodes);
  for (let i = children.length - 1; i >= 0; i--) {
    const found = lastTextNode(children[i]!);
    if (found) return found;
  }
  return null;
}
