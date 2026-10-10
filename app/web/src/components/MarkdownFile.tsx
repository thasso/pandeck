import { useMemo, type ComponentProps } from "react";
import { ChevronRight } from "lucide-react";
import {
  splitMarkdownFrontmatter,
  type FrontmatterField,
  type FrontmatterRef,
  type MarkdownFrontmatter,
} from "../lib/markdownFrontmatter.ts";
import { Markdown } from "./Markdown.tsx";
import { useMentionedPaObjectReferences } from "./PaObjectLinks.tsx";
import { FrontmatterValue, isVocabularyField } from "./frontmatterValues.tsx";
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
type MarkdownProps = ComponentProps<typeof Markdown>;

export function MarkdownFile({
  text,
  ...markdownProps
}: ComponentProps<typeof Markdown>) {
  const { frontmatter, body } = useMemo(
    () => splitMarkdownFrontmatter(text),
    [text],
  );
  // A file's text is fetched by its viewer, never seen by the host that
  // resolves transcript links, so its `pa://` titles come from the app here.
  const linked = useMentionedPaObjectReferences(text);
  const paObjectReferences =
    markdownProps.paObjectReferences ?? linked.references;
  const onOpenPaObject = markdownProps.onOpenPaObject ?? linked.onOpen;
  const linkProps = {
    ...(paObjectReferences ? { paObjectReferences } : {}),
    ...(onOpenPaObject ? { onOpenPaObject } : {}),
  };
  return (
    <>
      {frontmatter ? (
        <MarkdownFrontmatterHeader
          frontmatter={frontmatter}
          paObjectReferences={paObjectReferences}
          onOpenPaObject={onOpenPaObject}
          className="mb-4"
        />
      ) : null}
      <Markdown text={body} {...markdownProps} {...linkProps} />
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
  paObjectReferences,
  onOpenPaObject,
  className,
}: {
  frontmatter: MarkdownFrontmatter;
  /** The body's own link resolution, so a `pa://` source ref reads as its title. */
  paObjectReferences: MarkdownProps["paObjectReferences"];
  onOpenPaObject: MarkdownProps["onOpenPaObject"];
  className?: string;
}) {
  const { title, tags, fields, hiddenFields, source, parsed, raw } =
    frontmatter;
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
  if (
    !title &&
    tags.length === 0 &&
    fields.length === 0 &&
    hiddenFields.length === 0 &&
    !source
  )
    return null;
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
            {source ? (
              <>
                <PropertyLabel>Source</PropertyLabel>
                <PropertyText className="flex flex-col items-start gap-0.5">
                  {source.kind ? (
                    <FrontmatterValue field="kind" value={source.kind} />
                  ) : null}
                  {source.refs.length > 0 ? (
                    <RefLinks
                      refs={source.refs}
                      paObjectReferences={paObjectReferences}
                      onOpenPaObject={onOpenPaObject}
                    />
                  ) : null}
                </PropertyText>
              </>
            ) : null}
            {fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                paObjectReferences={paObjectReferences}
                onOpenPaObject={onOpenPaObject}
              />
            ))}
          </PropertyList>
          {hiddenFields.length > 0 ? (
            // Bookkeeping a reader rarely needs (the schema, the entry's id):
            // folded away under the rest, one click from view.
            <Collapsible className="mt-1">
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                  />
                }
              >
                <ChevronRight className="transition-transform in-aria-expanded:rotate-90" />
                {hiddenFields.length} more
              </CollapsibleTrigger>
              <CollapsibleContent>
                <PropertyList align="start" className="mt-1">
                  {hiddenFields.map((field) => (
                    <FieldRow
                      key={field.key}
                      field={field}
                      paObjectReferences={paObjectReferences}
                      onOpenPaObject={onOpenPaObject}
                    />
                  ))}
                </PropertyList>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </CardContent>
      </Card>
    </header>
  );
}

/** One frontmatter field as a label and its value, formatted by what it holds. */
function FieldRow({
  field,
  paObjectReferences,
  onOpenPaObject,
}: {
  field: FrontmatterField;
  paObjectReferences: MarkdownProps["paObjectReferences"];
  onOpenPaObject: MarkdownProps["onOpenPaObject"];
}) {
  return (
    <>
      <PropertyLabel>
        <span className="truncate" title={field.key}>
          {field.label}
        </span>
      </PropertyLabel>
      {field.date ? (
        <DateProperty date={field.date} />
      ) : isVocabularyField(field.key) && !field.links ? (
        <PropertyText>
          <FrontmatterValue field={field.key} value={field.value} />
        </PropertyText>
      ) : field.links ? (
        <PropertyText>
          <RefLinks
            refs={field.links}
            paObjectReferences={paObjectReferences}
            onOpenPaObject={onOpenPaObject}
          />
        </PropertyText>
      ) : (
        <PropertyText className="break-words" title={field.full}>
          {field.value}
        </PropertyText>
      )}
    </>
  );
}

/**
 * Frontmatter links, one per line, through the Markdown renderer: a `pa://`
 * link reads as its object's title and opens in the app, a web link shows its
 * short name (`sourceRefLabel`) and behaves as every other link does.
 */
function RefLinks({
  refs,
  paObjectReferences,
  onOpenPaObject,
}: {
  refs: readonly FrontmatterRef[];
  paObjectReferences: MarkdownProps["paObjectReferences"];
  onOpenPaObject: MarkdownProps["onOpenPaObject"];
}) {
  return (
    <Markdown
      density="compact"
      text={refs
        .map((ref) =>
          ref.href.startsWith("pa://")
            ? ref.href
            : `[${ref.label.replace(/[[\]]/g, "\\$&")}](<${ref.href}>)`,
        )
        .join("\\\n")}
      {...(paObjectReferences ? { paObjectReferences } : {})}
      onOpenPaObject={onOpenPaObject}
    />
  );
}
