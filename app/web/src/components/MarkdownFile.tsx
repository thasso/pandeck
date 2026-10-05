import { useMemo, type ComponentProps } from "react";
import {
  splitMarkdownFrontmatter,
  type MarkdownFrontmatter,
} from "../lib/markdownFrontmatter.ts";
import { Markdown } from "./Markdown.tsx";

/**
 * @component MarkdownFile
 * @purpose Renders a Markdown FILE: leading YAML frontmatter becomes a compact
 * metadata header and the rest renders as ordinary Markdown on the file's own
 * line numbers, so anchors and line comments keep addressing the source.
 * @useWhen A document viewer shows a Markdown file (host file, session
 * artifact, worktree preview).
 * @avoidWhen Chat or tool-output Markdown: use `Markdown`. Frontmatter only
 * means something at the top of a file.
 */
export function MarkdownFile({
  text,
  ...markdownProps
}: ComponentProps<typeof Markdown>) {
  const { frontmatter, body } = useMemo(
    () => splitMarkdownFrontmatter(text),
    [text],
  );
  return (
    <>
      {frontmatter ? (
        <MarkdownFrontmatterHeader frontmatter={frontmatter} className="mb-4" />
      ) : null}
      <Markdown text={body} {...markdownProps} />
    </>
  );
}

/**
 * @component MarkdownFrontmatterHeader
 * @purpose Compact metadata header above a rendered Markdown FILE: its
 * frontmatter title, tags as chips, and every other field as a label/value
 * row. Frontmatter outside the shared YAML subset shows as the raw block in a
 * collapsed disclosure instead of leaking into the rendered body.
 * @useWhen Through `MarkdownFile`.
 */
function MarkdownFrontmatterHeader({
  frontmatter,
  className,
}: {
  frontmatter: MarkdownFrontmatter;
  className?: string;
}) {
  const { title, tags, fields, parsed, raw } = frontmatter;
  if (!parsed) {
    return (
      <details
        className={`rounded-xl border border-line bg-panel/60 px-4 py-2 text-caption ${className ?? ""}`}
      >
        <summary className="cursor-pointer text-muted">Frontmatter</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-micro text-fg">
          {raw}
        </pre>
      </details>
    );
  }
  if (!title && tags.length === 0 && fields.length === 0) return null;
  return (
    <header
      aria-label="Document metadata"
      className={`flex flex-col gap-2 rounded-xl border border-line bg-panel/60 px-4 py-3 ${className ?? ""}`}
    >
      {title ? (
        <p className="text-body font-semibold text-fg">{title}</p>
      ) : null}
      {tags.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
          {tags.map((tag, index) => (
            <li
              key={`${index}:${tag}`}
              className="rounded-full border border-line bg-surface px-2 py-0.5 text-micro font-medium text-muted"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
      {fields.length > 0 ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
          {fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="text-faint">{field.key}</dt>
              <dd className="min-w-0 break-words text-muted">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </header>
  );
}
