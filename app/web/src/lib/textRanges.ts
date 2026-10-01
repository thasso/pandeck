/**
 * DOM text-offset helpers shared by every surface that anchors a comment to
 * rendered text (the transcript, document viewers). Offsets count the root's
 * text nodes in document order, the same measure `describeAnchor` uses.
 */

/** The Range covering `[start, end)` of `element`'s text, if both ends exist. */
export function rangeFromOffsets(
  element: HTMLElement,
  start: number,
  end: number,
): Range | null {
  if (start < 0 || end <= start) return null;
  const nodes: Text[] = [];
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  let consumed = 0;
  let startPoint: { node: Text; offset: number } | null = null;
  let endPoint: { node: Text; offset: number } | null = null;
  for (const node of nodes) {
    const next = consumed + node.length;
    if (!startPoint && start >= consumed && start <= next)
      startPoint = { node, offset: start - consumed };
    if (!endPoint && end >= consumed && end <= next)
      endPoint = { node, offset: end - consumed };
    consumed = next;
  }
  if (!startPoint || !endPoint) return null;
  const range = element.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/** The caret position under a viewport point, across browser APIs. */
export function pointAt(
  document: Document,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const withCaretPosition = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = withCaretPosition.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = withCaretPosition.caretRangeFromPoint?.(x, y);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}
