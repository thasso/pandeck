import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { IconButton } from "./common/IconButton.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";

type ChatWideCardProps = {
  children: ReactNode;
  maxWidth?: number;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Counts or totals, right-aligned in the header. */
  meta?: ReactNode;
};

/**
 * A tool card wider than the chat column: a `Card` that breaks out of the text
 * flow and centres in the chat area, with a header and a flush body (usually a
 * `Table`).
 */
export function ChatWideCard({
  children,
  maxWidth = 1120,
  icon,
  title,
  description,
  meta,
}: ChatWideCardProps) {
  return (
    <Card
      size="sm"
      style={
        {
          width: `min(${maxWidth}px, calc(var(--shell-main-width, 100vw) - 2rem))`,
          // Wide widgets are rendered inside assistant messages. Shift the
          // breakout shell back by half its own width so it centers in the chat
          // area rather than the text flow.
          transform: "translateX(-50%)",
        } as CSSProperties
      }
      className="relative left-1/2 my-3 max-w-none"
    >
      <CardHeader className="border-b">
        <CardTitle className="flex min-w-0 items-center gap-2">
          {icon}
          {title}
        </CardTitle>
        {description ? (
          <CardDescription className="min-w-0 truncate">
            {description}
          </CardDescription>
        ) : null}
        {meta ? (
          <CardAction className="text-right text-sm text-muted-foreground">
            {meta}
          </CardAction>
        ) : null}
      </CardHeader>
      {children}
    </Card>
  );
}

/** A title that links out when the payload carries a URL. */
export function ExternalTitle({
  title,
  href,
  mono = false,
}: {
  title: string;
  href?: string | null | undefined;
  mono?: boolean;
}) {
  const font = mono ? "font-mono" : "font-medium";
  if (!href) return <span className={`${font} text-foreground`}>{title}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex min-w-0 items-center gap-1 ${font} text-primary hover:underline`}
    >
      <span className="truncate">{title}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

export function EmptyRow({
  span,
  children,
}: {
  span: number;
  children: ReactNode;
}) {
  return (
    <TableRow>
      <TableCell
        colSpan={span}
        className="py-8 text-center text-muted-foreground"
      >
        {children}
      </TableCell>
    </TableRow>
  );
}

/**
 * A table row whose first cell opens a full-width detail row beneath it.
 * Uncontrolled by default; a row that loads its details on demand passes
 * `open`/`onOpenChange` and `busy`.
 */
export function ExpandableRow({
  expandLabel,
  collapseLabel,
  span,
  cells,
  details,
  open: openProp,
  onOpenChange,
  busy = false,
}: {
  expandLabel: string;
  collapseLabel: string;
  span: number;
  cells: ReactNode;
  /** Omitted when the row has nothing more to show. */
  details?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  busy?: boolean;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  return (
    <Fragment>
      <TableRow>
        <TableCell className="w-9 align-top">
          {details ? (
            <IconButton
              size="icon-xs"
              label={open ? collapseLabel : expandLabel}
              aria-expanded={open}
              busy={busy}
              onClick={() =>
                onOpenChange ? onOpenChange(!open) : setOpenState(!open)
              }
            >
              <ChevronDown className={open ? "rotate-180" : ""} />
            </IconButton>
          ) : null}
        </TableCell>
        {cells}
      </TableRow>
      {open && details ? (
        <TableRow>
          <TableCell colSpan={span} className="p-0">
            {/* Pinned to the visible width while the table scrolls sideways. */}
            <div
              className="sticky left-0 max-w-full p-3 whitespace-normal"
              style={{
                width:
                  "min(1500px, calc(var(--shell-main-width, 100vw) - 2rem))",
              }}
            >
              {details}
            </div>
          </TableCell>
        </TableRow>
      ) : null}
    </Fragment>
  );
}

/** A small bordered panel inside an expanded row. */
export function Panel({
  title,
  meta,
  children,
}: {
  title?: string;
  /** A short fact on the title line's right. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardContent>
        {title ? (
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <p className="font-medium">{title}</p>
            {meta}
          </div>
        ) : null}
        {children}
      </CardContent>
    </Card>
  );
}
