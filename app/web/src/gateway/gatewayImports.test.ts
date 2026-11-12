/**
 * The gateway page stays token-free and small (Task-1402 B2): `src/gateway/`
 * imports B1's login view, `ui/`, a few `common/` leaves, the fetch-state
 * hook, the shared gateway wire model and its own modules; never
 * `serverOrigin`, `useAssistant`, `useAccountLogin` or Pandeck's dialog host.
 */
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const DIR = new URL("./", import.meta.url);

const ALLOWED = [
  /^react$/,
  /^react-dom\/client$/,
  /^lucide-react$/,
  /^@assistant\/shared\/gatewayUi$/,
  /^\.\/[A-Za-z]+\.tsx?$/,
  /^\.\.\/components\/AccountLoginDialogView\.tsx$/,
  /^\.\.\/components\/ui\/[a-z-]+\.tsx$/,
  /^\.\.\/components\/common\/(?:load|dialogs|ListRow|ListRowActions|LinkButton|CopyableText)\.tsx$/,
  /^\.\.\/hooks\/useFetchState\.ts$/,
  /^\.\.\/lib\/loadState\.ts$/,
  /^\.\.\/index\.css$/,
];

test("src/gateway imports only what the gateway bundle may carry", () => {
  const files = readdirSync(DIR).filter(
    (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name),
  );
  expect(files.length).toBeGreaterThan(0);
  const offending: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, DIR), "utf8");
    expect(source).not.toMatch(/\bimport\(/);
    for (const match of source.matchAll(
      /^import\s+(type\s+)?(?:[^;]*?from\s+)?"([^"]+)";/gms,
    )) {
      const typeOnly = match[1] !== undefined;
      const from = match[2]!;
      // Types from the shared package are erased; values never come from it.
      if (typeOnly && from === "@assistant/shared") continue;
      if (!ALLOWED.some((rule) => rule.test(from)))
        offending.push(`${file}: ${from}`);
    }
    // Code only: the modules' comments may name what they avoid.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const banned of [
      "serverOrigin",
      "useAssistant",
      "useAccountLogin",
      "AccountLoginDialog.tsx",
    ])
      if (code.includes(banned)) offending.push(`${file}: ${banned}`);
  }
  expect(offending).toEqual([]);
});
