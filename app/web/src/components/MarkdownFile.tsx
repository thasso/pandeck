import { useMemo, type ComponentProps } from "react";
import {
  splitMarkdownFrontmatter,
  type MarkdownFrontmatter,
} from "../lib/markdownFrontmatter.ts";
import { Markdown } from "./Markdown.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible.tsx";

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
      <Collapsible className={className}>
        <Card size="sm">
          <CardHeader>
            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="sm" className="justify-start" />
              }
            >
              Frontmatter
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent keepMounted>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">
                {raw}
              </pre>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    );
  }
  if (!title && tags.length === 0 && fields.length === 0) return null;
  return (
    <header aria-label="Document metadata" className={className}>
      <Card size="sm">
        {title ? (
          <CardHeader>
            <CardTitle>{title}</CardTitle>
          </CardHeader>
        ) : null}
        <CardContent className="flex flex-col gap-2">
          {tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
              {tags.map((tag, index) => (
                <li key={`${index}:${tag}`}>
                  <Badge variant="outline">{tag}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
          {fields.length > 0 ? (
            <dl className="flex flex-col gap-1 text-muted-foreground">
              {fields.map((field) => (
                <div key={field.key} className="flex min-w-0 gap-3">
                  <dt className="w-28 shrink-0 truncate">{field.key}</dt>
                  <dd className="min-w-0 break-words" title={field.full}>
                    {field.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </CardContent>
      </Card>
    </header>
  );
}
