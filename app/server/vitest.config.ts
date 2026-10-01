import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Forks inherit this, so Node caches the compiled code of every package it
// loads natively and later test files reuse it instead of compiling again.
process.env.NODE_COMPILE_CACHE ??= join(
  import.meta.dirname,
  "node_modules/.cache/node-compile-cache",
);

// Deliberately no `deps.optimizer`: pre-bundling pi saved ~23 worker-seconds
// but made the bundled pi-ai a second instance, which misses the OAuth flows
// `piSdk/models.ts` registers natively, and moved pi's package files away from
// where it reads them. The other heavy packages gained nothing measurable.
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
  },
});
