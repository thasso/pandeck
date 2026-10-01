import type { DisplayMessage } from "@assistant/shared";
import { extractPaObjectLinkUris } from "@assistant/shared/objectLinks";

/**
 * What the transcript's link references are narrowed against.
 *
 * Both reference lists (`pa://` objects in `App.tsx`, sessions in
 * `MessageList.tsx`) are filtered to the objects the rendered text MENTIONS, so
 * naming an unrelated object is not a content change for every message on
 * screen. That makes this scan load-bearing in a way it was not when it only
 * decided which links to ask the server about: a field it forgets is a link
 * that silently renders without its title.
 *
 * So the one rule here is that it must cover EVERY string a transcript row
 * hands to `Markdown` with reference props. Today that is a text block and a
 * compaction card's summary (`AssistantMessage.tsx`); a peer-prompt card gets
 * no reference props and so needs no mention. Add the field here in the same
 * change that renders it.
 */
function markdownTextsOf(messages: readonly DisplayMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages)
    for (const block of message.blocks) {
      if (block.kind === "text") texts.push(block.text);
      else if (block.kind === "compaction")
        texts.push(block.compaction.summary);
    }
  return texts;
}

/** Session ids named in the rendered text, lower-cased like the autolink's lookup. */
const SESSION_ID_IN_TEXT =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function mentionedSessionIds(
  messages: readonly DisplayMessage[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const text of markdownTextsOf(messages))
    for (const match of text.matchAll(SESSION_ID_IN_TEXT))
      ids.add(match[0].toLowerCase());
  return ids;
}

/** `pa://` uris the rendered text mentions, with the renderer's own extractor. */
export function mentionedPaUris(messages: readonly DisplayMessage[]): string[] {
  return [
    ...new Set(markdownTextsOf(messages).flatMap(extractPaObjectLinkUris)),
  ];
}
