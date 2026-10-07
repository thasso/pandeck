import {
  MAX_DOCUMENT_ANCHOR_LINES,
  type DocumentLineAnchor,
} from "@assistant/shared/documentTargets";
import { DocumentAnchorRegion } from "./DocumentAnchorRegion.tsx";
import { CodeBlock } from "./common/CodeBlock.tsx";

/**
 * @component DocumentTextBody
 * @purpose The ONE line-oriented body for a text document, whatever serves it:
 * a host file, a captured artifact, a Knowledge file. Syntax-highlighted, with
 * the file's real line numbers, a bounded window (so neither a huge file nor a
 * huge `#L…` range can put a row per line in the DOM), two-direction reveal,
 * a copy action carrying the WHOLE source, and the addressed lines marked for
 * the surrounding `DocumentAnchorRegion` to scroll to.
 * @useWhen A document viewer has plain text or source to show.
 * @avoidWhen The content is Markdown (blocks, not lines), a diff, or a
 * transcript body — those have their own renderers.
 * @intent One window size, one notice, one set of controls: three sources that
 * drew their own `<pre>` had three answers to a large file, and two of them
 * were a row per line (`docs/document-presentation.md`).
 */
export function DocumentTextBody({
  text,
  name,
  anchor,
  className = "",
}: {
  text: string;
  /** File name; its extension picks the syntax highlighting. */
  name: string;
  anchor?: DocumentLineAnchor | undefined;
  className?: string;
}) {
  return (
    <DocumentAnchorRegion anchor={anchor} className={className}>
      <CodeBlock
        code={text}
        filename={name}
        showLineNumbers
        wrap
        copyable
        collapsedLines={MAX_DOCUMENT_ANCHOR_LINES}
        chunkLines={MAX_DOCUMENT_ANCHOR_LINES}
        lineAnchor={anchor}
      />
    </DocumentAnchorRegion>
  );
}
