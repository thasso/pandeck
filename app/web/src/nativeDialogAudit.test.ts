import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Native dialog audit.
 *
 * `window.confirm`, `window.alert` and `window.prompt` are BANNED in this
 * client. The Tauri shell's WKWebView never surfaces them: the call returns
 * immediately — `confirm` as `false`, `prompt` as `null` — so the action the
 * dialog guards silently does nothing, in an app that looks entirely healthy.
 * A browser tab where the user ticked "prevent additional dialogs" fails the
 * same way, and neither failure produces an error anyone could see.
 *
 * The replacement is `components/ui/dialog.tsx`: `useDialogs().confirm` /
 * `.promptText` for the ask-then-act case, `ConfirmDialog` for a flow that owns
 * its own open/busy/error state. Both are ordinary DOM and behave identically
 * in every client.
 *
 * The bare forms (`confirm(...)`, `alert(...)`, `prompt(...)`) resolve to the
 * same globals and are caught too; our own API is only ever reached through a
 * member call (`dialogs.confirm(...)`), which is why that spelling is the
 * sanctioned one. There is no baseline and no allowlist.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

const RULES: readonly { pattern: RegExp; what: string }[] = [
  {
    // `window.confirm(`, `globalThis . prompt (`, and the multi-line spelling
    // Prettier produces (`window\n  .prompt(`).
    pattern:
      /\b(?:window|globalThis|self)\s*\.\s*(?:confirm|alert|prompt)\s*\(/g,
    what: "native dialog on the global object",
  },
  {
    // A bare call, which is the same global. `dialogs.confirm(` and
    // `onConfirm(` are member/compound names and do not match, and the paren
    // must follow the name directly — prose like "into the prompt (with …)"
    // is not a call.
    pattern: /(?<![.\w$])(?:confirm|alert|prompt)\(/g,
    what: "bare native dialog call",
  },
  {
    // Destructuring the globals defeats both rules above.
    pattern:
      /\b(?:const|let|var)\s*\{[^}]*\b(?:confirm|alert|prompt)\b[^}]*\}\s*=\s*(?:window|globalThis|self)\b/g,
    what: "native dialog pulled off the global object",
  },
];

/** A fresh matcher per call: a shared `/g` regex carries `lastIndex` between uses. */
function hits(rule: (typeof RULES)[number], source: string): string[] {
  return source.match(new RegExp(rule.pattern.source, "g")) ?? [];
}

function shouldScan(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  // Tests carry XSS fixtures (`javascript:alert(1)`) and may stub a global on
  // purpose; production sources are what ships to the shell.
  if (/\.test\.[tj]sx?$/.test(path)) return false;
  if (/nativeDialogAudit\./.test(path)) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SCAN_EXTENSIONS.has(path.slice(dot));
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (shouldScan(full)) files.push(full);
  }
  return files.sort();
}

describe("native dialog audit", () => {
  test("no source raises a native confirm/alert/prompt", () => {
    const offenders: string[] = [];
    for (const file of collectFiles()) {
      const source = readFileSync(file, "utf8");
      for (const rule of RULES)
        for (const hit of hits(rule, source))
          offenders.push(
            `${relative(HERE, file)}: ${hit.replace(/\s+/g, " ")} (${rule.what})`,
          );
    }
    expect(
      offenders,
      `Native dialogs never appear in the Tauri shell's webview — ask through useDialogs()/ConfirmDialog in components/ui/dialog.tsx:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("catches every spelling it claims to", () => {
    const samples = [
      'if (window.confirm("x")) run();',
      "const t = window\n  .prompt('Rename', name)\n  ?.trim();",
      'globalThis.alert("x");',
      'if (!confirm("x")) return;',
      'alert("x");',
      "const { confirm } = window;",
    ];
    for (const sample of samples)
      expect(
        RULES.some((rule) => hits(rule, sample).length > 0),
        `missed: ${sample}`,
      ).toBe(true);
    // Our own API and lookalikes must NOT trip it.
    for (const clean of [
      "await dialogs.confirm({ title: t });",
      "const confirmed = await dialogs.confirm(options);",
      "onConfirm(value);",
      "const [confirmForce, setConfirmForce] = useState(false);",
      "sendPrompt(text);",
      "const prompt = buildPrompt();",
      "// completes the highlighted command into the prompt (with a space)",
    ])
      for (const rule of RULES)
        expect(hits(rule, clean), `false positive: ${clean}`).toEqual([]);
  });
});
