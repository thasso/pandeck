import { useState, type HTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

import { CopyButton } from "./CopyButton";

export interface JsonViewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  /** The already-parsed JSON value to render (object, array, or primitive). */
  value: unknown;
  /**
   * Depth to expand by default; nodes deeper than this start collapsed behind a
   * count. Defaults to `2`.
   */
  defaultExpandedDepth?: number;
  /** Extra classes on the outer container. */
  className?: string;
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function isContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

/** A primitive JSON value, colored by type with semantic tokens. */
function Primitive({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <span className="text-success break-all">&quot;{value}&quot;</span>;
  }
  if (typeof value === "number") {
    return <span className="text-primary">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-primary">{String(value)}</span>;
  }
  // null / undefined / functions etc.
  return <span className="text-muted-foreground">null</span>;
}

function entriesOf(
  value: Record<string, unknown> | unknown[],
): Array<[string, unknown]> {
  return Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
}

function countLabel(value: Record<string, unknown> | unknown[]): string {
  const n = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (Array.isArray(value)) return `${n} ${n === 1 ? "item" : "items"}`;
  return `${n} ${n === 1 ? "key" : "keys"}`;
}

/** One node: a primitive, or a collapsible object/array with an optional key. */
function Node({
  keyName,
  showKey,
  value,
  depth,
  defaultExpandedDepth,
}: {
  keyName?: string;
  showKey: boolean;
  value: unknown;
  depth: number;
  defaultExpandedDepth: number;
}) {
  const [open, setOpen] = useState(depth < defaultExpandedDepth);

  const keyPart = showKey ? (
    <>
      <span className="text-foreground">&quot;{keyName}&quot;</span>
      <span className="text-muted-foreground">: </span>
    </>
  ) : null;

  if (!isContainer(value)) {
    return (
      <div className="whitespace-pre-wrap">
        {keyPart}
        <Primitive value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const open_b = isArray ? "[" : "{";
  const close_b = isArray ? "]" : "}";
  const entries = entriesOf(value);

  if (entries.length === 0) {
    return (
      <div>
        {keyPart}
        <span className="text-muted-foreground">{open_b + close_b}</span>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <ChevronDown
          aria-hidden="true"
          size={12}
          className={cx(
            "shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
        {keyPart}
        <span className="text-muted-foreground">{open_b}</span>
        {!open && (
          <span className="text-muted-foreground">
            … {close_b} <span className="italic">{countLabel(value)}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="ml-2 border-l border-border pl-3">
          {entries.map(([k, v]) => (
            <Node
              key={k}
              keyName={k}
              showKey={!isArray}
              value={v}
              depth={depth + 1}
              defaultExpandedDepth={defaultExpandedDepth}
            />
          ))}
        </div>
      )}
      {open && <span className="text-muted-foreground">{close_b}</span>}
    </div>
  );
}

/**
 * Render a parsed JSON value as a collapsible, color-coded tree — the default
 * body for MCP / unknown tool calls (inputs and outputs). Objects and arrays
 * toggle open/closed (collapsed past `defaultExpandedDepth`, with an entry
 * count); primitives are colored by type with semantic tokens. A copy action
 * yields the pretty-printed JSON. Feed it an already-parsed value (the
 * tool-renderer parses JSON-string output before handing it here).
 */
export function JsonView({
  value,
  defaultExpandedDepth = 2,
  className,
  ...props
}: JsonViewProps) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value, null, 2) ?? "";
  } catch {
    serialized = String(value);
  }

  return (
    <div
      className={cx(
        "group relative font-mono text-sm text-foreground",
        className,
      )}
      {...props}
    >
      {serialized && (
        <CopyButton
          value={serialized}
          size="icon-sm"
          className="absolute right-0 top-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        />
      )}
      <Node
        showKey={false}
        value={value}
        depth={0}
        defaultExpandedDepth={defaultExpandedDepth}
      />
    </div>
  );
}
