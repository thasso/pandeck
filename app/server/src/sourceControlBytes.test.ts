/**
 * Task 393: repository text files carry no stray control bytes.
 *
 * A literal U+0000 in a source file is not a cosmetic issue: git's binary
 * heuristic (a NUL in the first 8000 bytes) renders the whole file's diff as
 * "Binary files ... differ", which no commit or PR review can inspect. That
 * blocked a run twice via `app/web/src/lib/sessionRows.ts`. The root
 * `.gitattributes` now forces `*.ts`/`*.tsx` to diff as text so a stray byte
 * can no longer hide a diff; this test keeps the bytes out of the sources in
 * the first place, for every text file and not just TypeScript.
 *
 * The scanned set is every file git would show a diff for: tracked files PLUS
 * untracked, non-ignored ones. The untracked half is the point — the file an
 * agent just WROTE with a literal NUL is untracked while the tests run, and
 * `commit-sync` staging it is one step too late to catch it here.
 *
 * Control characters that a string needs are spelled as escape sequences
 * (a JS \u0000 or \u001f literal) — same runtime value, reviewable source.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// Derived locally rather than imported from `promptInventory.ts`: that module
// costs ~3s to load, which would dwarf this test's own ~50ms of work.
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Binary assets, which legitimately contain arbitrary bytes. */
const BINARY_EXTENSIONS = new Set([
  ".bin",
  ".gif",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".pdf",
  ".png",
  ".ttf",
  ".wav",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

/** Tab, line feed, and carriage return are the only control bytes text needs. */
const ALLOWED_CONTROL_BYTES = new Set([0x09, 0x0a, 0x0d]);

function isControlByte(byte: number): boolean {
  return (byte <= 0x1f || byte === 0x7f) && !ALLOWED_CONTROL_BYTES.has(byte);
}

/** Tracked plus untracked-but-not-ignored paths, relative to {@link REPO_ROOT}. */
function scannableFiles(): string[] {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const paths = listing.split("\0").filter((path) => path.length > 0);
  return [...new Set(paths)];
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

test("repository text files contain no stray control bytes", () => {
  const violations: string[] = [];
  let scanned = 0;

  for (const path of scannableFiles()) {
    if (BINARY_EXTENSIONS.has(extensionOf(path))) continue;
    let content: Buffer;
    try {
      content = readFileSync(join(REPO_ROOT, path));
    } catch (error) {
      // A tracked path missing from the worktree (a sparse or partial checkout)
      // is not this test's concern; any other read failure is real and must not
      // quietly shrink the scanned set.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      continue;
    }
    scanned += 1;

    for (let offset = 0; offset < content.length; offset += 1) {
      const byte = content[offset]!;
      if (!isControlByte(byte)) continue;
      const hex = byte.toString(16).padStart(2, "0");
      violations.push(
        `${path}: byte 0x${hex} at offset ${offset} — remove it, or in TS/JS write it as a \\u${hex.padStart(4, "0")} escape`,
      );
      break; // One report per file is enough to point at it.
    }
  }

  assert.deepEqual(violations, []);
  // Guard the guard: a broken `git ls-files` must not pass vacuously.
  assert.ok(
    scanned > 100,
    `expected to scan the repo, scanned ${scanned} files`,
  );
});
