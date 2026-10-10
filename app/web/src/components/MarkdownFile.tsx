import { Fragment, useMemo, type ComponentProps } from "react";
import {
  splitMarkdownFrontmatter,
  type MarkdownFrontmatter,
} from "../lib/markdownFrontmatter.ts";
import { Markdown } from "./Markdown.tsx";
import {
  DateProperty,
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "./common/PropertyList.tsx";
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
 * frontmatter title, then a `PropertyList` — the tags as chips, and every
 * other field as a label/value row, in the same label column as everywhere else. Frontmatter outside the shared YAML subset shows as the raw block in a
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
        <CardContent>
          <PropertyList align="start">
            {tags.length > 0 ? (
              <>
                <PropertyLabel>Tags</PropertyLabel>
                <PropertyText>
                  <ul className="flex flex-wrap gap-1" aria-label="Tags">
                    {tags.map((tag, index) => (
                      <li key={`${index}:${tag}`}>
                        <Badge variant="outline">{tag}</Badge>
                      </li>
                    ))}
                  </ul>
                </PropertyText>
              </>
            ) : null}
            {fields.map((field) => (
              <Fragment key={field.key}>
                <PropertyLabel>
                  <span className="truncate" title={field.key}>
                    {field.label}
                  </span>
                </PropertyLabel>
                {field.date ? (
                  <DateProperty date={field.date} />
                ) : (
                  <PropertyText className="break-words" title={field.full}>
                    {field.value}
                  </PropertyText>
                )}
              </Fragment>
            ))}
          </PropertyList>
        </CardContent>
      </Card>
    </header>
  );
}
