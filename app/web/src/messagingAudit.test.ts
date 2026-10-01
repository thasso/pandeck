import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { expect, it } from "vitest";

/**
 * `docs/messaging.md`: THERE IS NO BANNER CHANNEL. A full-width tinted row that
 * pushes the page down is not a message surface — it cannot say which object it
 * is about, cannot be acted on, and outlives the thing it describes. The app
 * carried three of them (the global notice bar, its Settings copy, the
 * dev-restart bar) and the last one moved into the app status slot.
 *
 * This is an audit rather than a render test because the failure is a NEW one
 * appearing: nothing that exists today breaks when someone adds a fourth, and
 * a banner is the most natural-looking thing in the world to reach for.
 */

const SRC = join(import.meta.dirname, ".");

/** The shape being banned: a tinted, bottom-bordered, full-bleed row. */
const BANNER =
  /border-b\s+border-(danger|accent|warning|success|yellow|amber|emerald|red)/;

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    found.push(path);
  }
  return found;
}

it("has no tinted full-width banner outside the app status slot", () => {
  const offenders = sourceFiles(SRC)
    .filter((path) => BANNER.test(readFileSync(path, "utf8")))
    .map((path) => path.slice(SRC.length));
  expect(
    offenders,
    `A tinted full-width bar is the banner channel returning. A failure belongs on its object (\`ErrorNote\`), an event whose surface is gone belongs in a toast, and app-wide lifecycle state belongs in \`AppStatus\`. See docs/messaging.md.`,
  ).toEqual([]);
});

/**
 * The other half of the same rule: exactly one component renders the app status
 * slot, and exactly one renders toasts. A second renderer of either is how a
 * channel quietly becomes two channels that disagree.
 */
it("keeps one renderer for each global channel", () => {
  const files = sourceFiles(SRC);
  const named = (paths: string[]) =>
    paths.map((path) => path.slice(SRC.length)).sort();

  // The app status slot: the only full-width overlay anchored to the top.
  const statusRenderers = files.filter((path) =>
    /fixed\s+inset-x-0[^"'`]*top-/.test(readFileSync(path, "utf8")),
  );
  expect(named(statusRenderers)).toEqual(["/components/AppStatus.tsx"]);

  // The ephemeral channel: exactly one component reads the toast store...
  const toastRenderers = files.filter(
    (path) =>
      /subscribeToasts/.test(readFileSync(path, "utf8")) &&
      !path.endsWith(`${sep}toast.ts`),
  );
  expect(named(toastRenderers)).toEqual(["/components/ToastViewport.tsx"]);

  // ...and it is MOUNTED exactly once. Subscribing in one file proves nothing
  // about how often it is rendered: a second `<ToastViewport />` anywhere draws
  // a duplicate of every toast, which is the concrete regression this rule
  // exists to stop. Same for the status slot, whose two mounts are the two
  // shells (`App.tsx` floating, `Topbar.tsx` inline) and never a third.
  const mounts = (tag: string) =>
    files.flatMap((path) => {
      const hits = readFileSync(path, "utf8").match(
        new RegExp(`<${tag}[\\s/>]`, "g"),
      );
      return hits ? hits.map(() => path.slice(SRC.length)) : [];
    });
  expect(mounts("ToastViewport")).toEqual(["/App.tsx"]);
  expect(mounts("AppStatus").sort()).toEqual([
    "/App.tsx",
    "/components/Topbar.tsx",
  ]);
});
