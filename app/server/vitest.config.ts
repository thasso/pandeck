import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Forks inherit this, so Node caches the compiled code of every package it
// loads natively and later test files reuse it instead of compiling again.
process.env.NODE_COMPILE_CACHE ??= join(
  import.meta.dirname,
  "node_modules/.cache/node-compile-cache",
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    isolate: true,
    silent: "passed-only",
    deps: {
      optimizer: {
        ssr: {
          // Each test file loads its imports again, and these packages are
          // hundreds of files each; one pre-bundled file per package loads in a
          // fraction of the time. jsdom stays out: its bundle reads
          // `__dirname`, which an ES module does not have.
          enabled: true,
          include: [
            "@earendil-works/pi-coding-agent",
            "@earendil-works/pi-ai",
            "@modelcontextprotocol/sdk",
            "typebox",
          ],
        },
      },
    },
  },
});
