import type { CSSProperties } from "react";

/**
 * Renders text that may contain ANSI SGR escape sequences (colored terminal
 * output, e.g. from a `bash` tool) as styled spans, and strips non-SGR control
 * sequences (cursor moves, screen erase) so they don't show as raw `[..m` noise.
 *
 * Colors map to the Catppuccin ANSI palette via `--ansi-*` CSS variables (see
 * `index.css`), so they adapt to light/dark like the rest of the UI;
 * 256-color cube and 24-bit truecolor codes resolve to literal `rgb(...)`.
 * Renders synchronously (no effects), so it works under `renderToStaticMarkup`.
 */
export interface AnsiTextProps {
  /** The raw text, possibly containing ANSI escape sequences. */
  text: string;
  /** Extra classes on the `<pre>` wrapper. */
  className?: string;
}

interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const BASIC = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** A basic (0-7) / bright (8-15) ANSI color as its palette CSS variable. */
function colorVar(index: number, bright: boolean): string {
  const name = BASIC[index] ?? "white";
  return `var(--ansi-${bright ? "bright-" : ""}${name})`;
}

/** An xterm 256-color index as a color string (palette var or `rgb(...)`). */
function color256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 16) return colorVar(n % 8, n >= 8);
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v}, ${v}, ${v})`;
  }
  const i = n - 16;
  const conv = (c: number) => (c === 0 ? 0 : 55 + c * 40);
  const r = conv(Math.floor(i / 36));
  const g = conv(Math.floor((i % 36) / 6));
  const b = conv(i % 6);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Fold one SGR parameter list onto the running style. */
function applySgr(style: AnsiStyle, params: number[]): AnsiStyle {
  const next: AnsiStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      // `next` inherits the running style, so a reset must REMOVE the colour
      // rather than carry it as present-and-undefined.
      delete next.fg;
      delete next.bg;
      next.bold = next.dim = next.italic = next.underline = false;
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) {
      next.bold = false;
      next.dim = false;
    } else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p === 39) delete next.fg;
    else if (p === 49) delete next.bg;
    else if (p >= 30 && p <= 37) next.fg = colorVar(p - 30, false);
    else if (p >= 90 && p <= 97) next.fg = colorVar(p - 90, true);
    else if (p >= 40 && p <= 47) next.bg = colorVar(p - 40, false);
    else if (p >= 100 && p <= 107) next.bg = colorVar(p - 100, true);
    else if (p === 38 || p === 48) {
      const mode = params[i + 1];
      if (mode === 5) {
        // 256-color: 38;5;n. Ignore (leave unchanged) when n is missing.
        const n = params[i + 2];
        const color = n == null ? undefined : color256(n);
        if (color) {
          if (p === 38) next.fg = color;
          else next.bg = color;
        }
        i += 2;
      } else if (mode === 2) {
        // Truecolor: 38;2;r;g;b. Ignore when any channel is missing.
        const r = params[i + 2];
        const g = params[i + 3];
        const b = params[i + 4];
        if (r != null && g != null && b != null) {
          const color = `rgb(${r}, ${g}, ${b})`;
          if (p === 38) next.fg = color;
          else next.bg = color;
        }
        i += 4;
      }
    }
  }
  return next;
}

interface AnsiToken {
  text: string;
  style: AnsiStyle;
}

// Matches a full CSI sequence: ESC [ <param bytes> <intermediate bytes> <final
// byte>, per ECMA-48. A *styling* (SGR) sequence is the subset with only
// numeric/`;` params and the final byte `m`; every other CSI — cursor moves,
// erase, private modes like `?25l` — is matched here so it is stripped rather
// than leaking as raw text.
// oxlint-disable-next-line no-control-regex -- ANSI escape sequences ARE control characters; matching them is the point.
const CSI = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
const SGR_PARAMS = /^[0-9;]*$/;

/** Split ANSI text into styled runs, dropping non-SGR control sequences. */
function parseAnsi(input: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (text: string) => {
    // Drop any stray ESC introducer not consumed as part of a CSI sequence, so
    // a malformed escape never renders as a raw control char.
    const clean = text.split("\x1b").join("");
    if (clean.length > 0) tokens.push({ text: clean, style });
  };
  for (let m = CSI.exec(input); m !== null; m = CSI.exec(input)) {
    push(input.slice(last, m.index));
    last = CSI.lastIndex;
    const params = m[1] ?? "";
    const isSgr =
      m[3] === "m" && (m[2] ?? "") === "" && SGR_PARAMS.test(params);
    if (isSgr) {
      const codes =
        params === ""
          ? [0]
          : params.split(";").map((s) => (s === "" ? 0 : Number(s)));
      style = applySgr(style, codes);
    }
  }
  CSI.lastIndex = 0;
  push(input.slice(last));
  return tokens;
}

function styleToCss(style: AnsiStyle): CSSProperties {
  const css: CSSProperties = {};
  if (style.fg) css.color = style.fg;
  if (style.bg) css.backgroundColor = style.bg;
  if (style.bold) css.fontWeight = 700;
  if (style.italic) css.fontStyle = "italic";
  if (style.underline) css.textDecoration = "underline";
  if (style.dim) css.opacity = 0.7;
  return css;
}

export function AnsiText({ text, className }: AnsiTextProps) {
  const tokens = parseAnsi(text);
  return (
    <pre
      className={cx(
        "overflow-x-auto whitespace-pre font-mono text-caption text-muted",
        className,
      )}
    >
      {tokens.map((token, index) => {
        const css = styleToCss(token.style);
        return Object.keys(css).length === 0 ? (
          <span key={index}>{token.text}</span>
        ) : (
          <span key={index} style={css}>
            {token.text}
          </span>
        );
      })}
    </pre>
  );
}
