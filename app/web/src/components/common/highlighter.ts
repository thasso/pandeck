/**
 * The single syntax highlighter for the whole UI: a Shiki core instance
 * (JavaScript regex engine — no WASM) with Catppuccin Latte/Mocha themes. Both
 * `CodeBlock` and Markdown fences highlight through this, and the diff view uses
 * Shiki too, so the app has one consistent highlighter.
 *
 * Keep the initial bundle small: only common chat languages are loaded eagerly;
 * less common grammars are dynamically imported on demand. Components render a
 * plain code fallback until the requested grammar is available, then re-render.
 *
 * Themes are emitted as dual light/dark CSS variables (`defaultColor: false`);
 * the `.shiki` rules in `index.css` pick `--shiki-light` / `--shiki-dark`
 * off the `html.dark` class.
 */

import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import catppuccinLatte from "@shikijs/themes/catppuccin-latte";
import catppuccinMocha from "@shikijs/themes/catppuccin-mocha";

import bash from "@shikijs/langs/bash";
import diff from "@shikijs/langs/diff";
import json from "@shikijs/langs/json";
import markdown from "@shikijs/langs/markdown";

/** Shiki theme id used for the light (Catppuccin Latte) palette. */
const LIGHT_THEME = "catppuccin-latte";
/** Shiki theme id used for the dark (Catppuccin Mocha) palette. */
const DARK_THEME = "catppuccin-mocha";

/**
 * File extension → Shiki language id. Shared by every surface that infers a
 * language from a path (`CodeBlock`, the diff view), so they agree on the
 * mapping.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  "c#": "csharp",
  h: "c",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  md: "markdown",
  yml: "yaml",
  txt: "plaintext",
  text: "plaintext",
  plain: "plaintext",
};

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  xml: "xml",
  md: "markdown",
  markdown: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  sql: "sql",
  php: "php",
  diff: "diff",
  txt: "plaintext",
};

function normalizeLanguageId(language?: string): string | undefined {
  const normalized = language
    ?.trim()
    .replace(/^language-/, "")
    .replace(/^\./, "")
    .toLowerCase();
  if (!normalized) return undefined;
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

/** The Shiki language id for a filename's extension, or `undefined`. */
export function languageFromFilename(filename?: string): string | undefined {
  if (!filename) return undefined;
  const ext = filename.split(".").pop();
  return normalizeLanguageId(
    ext ? (EXTENSION_LANGUAGE[ext.toLowerCase()] ?? ext) : undefined,
  );
}

/** Normalize a user/file-provided language id to the Shiki id this module uses. */
export function resolveHighlighterLanguage(
  language?: string,
): string | undefined {
  return normalizeLanguageId(language);
}

const highlighter = createHighlighterCoreSync({
  themes: [catppuccinLatte, catppuccinMocha],
  langs: [bash, diff, json, markdown],
  // `forgiving` keeps the JS engine from throwing on the rare grammar regex it
  // can't compile; that token just isn't highlighted.
  engine: createJavaScriptRegexEngine({ forgiving: true }),
});

type LanguageInput = Parameters<typeof highlighter.loadLanguageSync>[0];
type LanguageLoader = () => Promise<LanguageInput>;

const languageLoaders: Record<string, LanguageLoader> = {
  c: () => import("@shikijs/langs/c").then((module) => module.default),
  cpp: () => import("@shikijs/langs/cpp").then((module) => module.default),
  csharp: () =>
    import("@shikijs/langs/csharp").then((module) => module.default),
  css: () => import("@shikijs/langs/css").then((module) => module.default),
  go: () => import("@shikijs/langs/go").then((module) => module.default),
  html: () => import("@shikijs/langs/html").then((module) => module.default),
  ini: () => import("@shikijs/langs/ini").then((module) => module.default),
  java: () => import("@shikijs/langs/java").then((module) => module.default),
  javascript: () =>
    import("@shikijs/langs/javascript").then((module) => module.default),
  jsx: () => import("@shikijs/langs/jsx").then((module) => module.default),
  kotlin: () =>
    import("@shikijs/langs/kotlin").then((module) => module.default),
  less: () => import("@shikijs/langs/less").then((module) => module.default),
  php: () => import("@shikijs/langs/php").then((module) => module.default),
  python: () =>
    import("@shikijs/langs/python").then((module) => module.default),
  ruby: () => import("@shikijs/langs/ruby").then((module) => module.default),
  rust: () => import("@shikijs/langs/rust").then((module) => module.default),
  scss: () => import("@shikijs/langs/scss").then((module) => module.default),
  sql: () => import("@shikijs/langs/sql").then((module) => module.default),
  toml: () => import("@shikijs/langs/toml").then((module) => module.default),
  typescript: () =>
    import("@shikijs/langs/typescript").then((module) => module.default),
  tsx: () => import("@shikijs/langs/tsx").then((module) => module.default),
  xml: () => import("@shikijs/langs/xml").then((module) => module.default),
  yaml: () => import("@shikijs/langs/yaml").then((module) => module.default),
};

let loaded = new Set(
  highlighter
    .getLoadedLanguages()
    .map(resolveHighlighterLanguage)
    .filter((lang): lang is string => Boolean(lang)),
);
const loading = new Map<string, Promise<boolean>>();

function refreshLoadedLanguages(): void {
  loaded = new Set(
    highlighter
      .getLoadedLanguages()
      .map(resolveHighlighterLanguage)
      .filter((lang): lang is string => Boolean(lang)),
  );
}

/** Whether a language id (or alias, e.g. `ts`) is already loaded and can be highlighted. */
export function isLanguageSupported(language?: string): language is string {
  const resolved = resolveHighlighterLanguage(language);
  return resolved != null && resolved !== "plaintext" && loaded.has(resolved);
}

/** Dynamically import and register a language grammar if it is available. */
export function ensureLanguageLoaded(language?: string): Promise<boolean> {
  const resolved = resolveHighlighterLanguage(language);
  if (!resolved || resolved === "plaintext") return Promise.resolve(false);
  if (isLanguageSupported(resolved)) return Promise.resolve(true);
  const loader = languageLoaders[resolved];
  if (!loader) return Promise.resolve(false);

  const existing = loading.get(resolved);
  if (existing) return existing;

  const promise = loader()
    .then((registration) => {
      highlighter.loadLanguageSync(registration);
      refreshLoadedLanguages();
      return isLanguageSupported(resolved);
    })
    .catch(() => false)
    .finally(() => {
      loading.delete(resolved);
    });
  loading.set(resolved, promise);
  return promise;
}

/**
 * Bounded (code, language) → hast cache. Highlighting is the single most
 * expensive thing the transcript does — measured at ~5 ms for a 12-line tool
 * preview, so a chat with a few hundred file tool calls pays seconds of
 * synchronous work — and callers legitimately re-render for unrelated reasons
 * (a preference flip, a collapse/expand, a new streaming message). Results are
 * theme-independent (dual light/dark CSS variables), so one entry serves both
 * themes. Insertion-ordered eviction (a Map re-set on hit = LRU) bounds memory
 * by BOTH entry count and total cached source length.
 */
const HAST_CACHE_MAX_ENTRIES = 400;
const HAST_CACHE_MAX_CHARS = 2_000_000;
type Hast = ReturnType<typeof highlighter.codeToHast>;
const hastCache = new Map<string, Hast>();
let hastCacheChars = 0;

function cacheHast(key: string, code: string, value: Hast): void {
  hastCache.set(key, value);
  hastCacheChars += code.length;
  while (
    hastCache.size > HAST_CACHE_MAX_ENTRIES ||
    hastCacheChars > HAST_CACHE_MAX_CHARS
  ) {
    const oldest = hastCache.keys().next();
    if (oldest.done) break;
    // The key is `${language}\u0000${code}`, so its length recovers the code length.
    hastCacheChars -= Math.max(
      0,
      oldest.value.length - (oldest.value.indexOf("\u0000") + 1),
    );
    hastCache.delete(oldest.value);
  }
}

/**
 * Highlight `code` to a hast tree with dual light/dark Catppuccin themes,
 * memoized (see {@link hastCache}). Call only when {@link isLanguageSupported}
 * is true for `language`.
 */
export function highlightToHast(code: string, language: string) {
  const resolved = resolveHighlighterLanguage(language) ?? language;
  const key = `${resolved}\u0000${code}`;
  const cached = hastCache.get(key);
  if (cached) {
    // Re-set so the hot entry moves to the back of the eviction order.
    hastCache.delete(key);
    hastCache.set(key, cached);
    return cached;
  }
  const hast = highlighter.codeToHast(code, {
    lang: resolved,
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: false,
  });
  cacheHast(key, code, hast);
  return hast;
}

/**
 * Whether a highlight for this exact (code, language) is already memoized — so a
 * caller can render it synchronously instead of deferring to idle time and
 * flashing unhighlighted code (see `CodeBlock`).
 */
export function hasCachedHighlight(code: string, language: string): boolean {
  const resolved = resolveHighlighterLanguage(language) ?? language;
  return hastCache.has(`${resolved}\u0000${code}`);
}

/** Test seam: drop every memoized highlight result. */
export function clearHighlightCache(): void {
  hastCache.clear();
  hastCacheChars = 0;
}
