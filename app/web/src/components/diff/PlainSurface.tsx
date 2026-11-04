/**
 * What a Pierre surface shows before its worker pool is ready: the raw text,
 * right away. Pierre draws nothing at all until its highlighter has loaded —
 * not even plain text — so on a cold start (the app just opened, the iOS app
 * resumed) a file or diff would otherwise stay empty while Shiki loads. These
 * stand-ins carry no colour and no interactions; Pierre replaces them as soon
 * as it can draw, and highlights in the background from there.
 */

// `plain-surface` (index.css) takes Pierre's own type size, so the swap
// to the drawn surface does not move a line.
const SHELL =
  "plain-surface overflow-x-auto bg-card py-1 font-mono text-foreground/90";

/** A file's lines, numbered. */
export function PlainFile({ contents }: { contents: string }) {
  const lines = contents.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return (
    <pre className={SHELL}>
      {lines.map((line, index) => (
        <div key={index} className="flex">
          <span className="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground/60">
            {index + 1}
          </span>
          <span className="whitespace-pre pr-4">{line || " "}</span>
        </div>
      ))}
    </pre>
  );
}

/** A unified patch's hunks: added and removed lines tinted, headers muted. */
export function PlainPatch({ patch }: { patch: string }) {
  const lines = patch
    .split("\n")
    .filter(
      (line) =>
        !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(
          line,
        ),
    );
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return (
    <pre className={SHELL}>
      {lines.map((line, index) => {
        const tone = line.startsWith("@@")
          ? "text-muted-foreground"
          : line.startsWith("+")
            ? "bg-success/10"
            : line.startsWith("-")
              ? "bg-destructive/10"
              : "";
        return (
          <div key={index} className={`whitespace-pre px-4 ${tone}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
