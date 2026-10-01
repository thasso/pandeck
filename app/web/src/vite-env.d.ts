/// <reference types="vite/client" />

/**
 * This bundle's build identity, replaced at build time by `vite.config.ts`.
 * Read it through `lib/appBuild.ts`, which handles the one case where the
 * define is absent (a loader that is not Vite).
 */
declare const __ASSISTANT_BUILD__: import("@assistant/shared/buildInfo").BuildInfo;
