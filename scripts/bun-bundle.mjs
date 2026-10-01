import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

/**
 * How the Bun package bundles server code: the dependency lookups, the
 * `node:sqlite`, Photon and JSDOM substitutions, and the esbuild call. The
 * package builder uses it for `server.js`, and the install check for its
 * runtime probe, so a probe runs the same shims the server does.
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function directDependencyRoot(packageName) {
  return realpathSync(
    join(repoRoot, "app", "server", "node_modules", ...packageName.split("/")),
  );
}

export function dependencyRoot(owner, dependency) {
  const packageNodeModules = resolve(directDependencyRoot(owner), "../..");
  return join(packageNodeModules, ...dependency.split("/"));
}

/** What the bundled server module is compiled with. */
export const SERVER_BUNDLE_DEFINE = {
  __ASSISTANT_BUN_BUNDLE__: "true",
  "process.env.NODE_ENV": JSON.stringify("production"),
};

export function serverBundlePlugins() {
  const jsdomRoot = directDependencyRoot("jsdom");
  const defaultStylesheet = readFileSync(
    join(jsdomRoot, "lib/jsdom/browser/default-stylesheet.css"),
    "utf8",
  );
  const sqliteShim = join(repoRoot, "scripts/bun-shims/node-sqlite.mjs");
  const childProcessShim = join(
    repoRoot,
    "scripts/bun-shims/node-child-process.mjs",
  );
  const photonShim = join(repoRoot, "scripts/bun-shims/photon-node.mjs");
  const jsdomAssetsShim = join(
    repoRoot,
    "scripts/bun-shims/jsdom-runtime-assets.mjs",
  );
  const xhrWorkerLookup =
    'const syncWorkerFile = require("@assistant/jsdom-runtime-assets")' +
    ".PACKAGED_XHR_SYNC_WORKER;";

  return [
    {
      name: "node-sqlite-compat",
      setup(build) {
        build.onResolve({ filter: /^node:sqlite$/ }, () => ({
          path: sqliteShim,
        }));
      },
    },
    {
      name: "child-process-env-compat",
      setup(build) {
        // The shim itself imports the real builtin.
        build.onResolve(
          { filter: /^(node:)?child_process$/ },
          ({ importer }) =>
            importer === childProcessShim
              ? undefined
              : { path: childProcessShim },
        );
      },
    },
    {
      name: "packaged-photon-wasm",
      setup(build) {
        build.onResolve({ filter: /^@silvia-odwyer\/photon-node$/ }, () => ({
          path: photonShim,
        }));
      },
    },
    {
      name: "packaged-jsdom-assets",
      setup(build) {
        build.onResolve(
          { filter: /^@assistant\/jsdom-runtime-assets$/ },
          () => ({
            path: jsdomAssetsShim,
          }),
        );
        build.onLoad(
          {
            filter: /jsdom\/lib\/jsdom\/living\/xhr\/XMLHttpRequest-impl\.js$/,
          },
          ({ path }) => {
            const source = readFileSync(path, "utf8");
            const needle =
              'const syncWorkerFile = require.resolve("./xhr-sync-worker.js");';
            if (!source.includes(needle))
              throw new Error(
                "JSDOM sync worker loader changed; update the bundle patch.",
              );
            return {
              contents: source.replace(needle, xhrWorkerLookup),
              loader: "js",
            };
          },
        );
        build.onLoad(
          {
            filter:
              /jsdom\/lib\/jsdom\/living\/css\/helpers\/computed-style\.js$/,
          },
          ({ path }) => {
            const source = readFileSync(path, "utf8");
            const needle =
              'const fs = require("node:fs");\n' +
              'const path = require("node:path");\n';
            const stylesheetNeedle =
              "const defaultStyleSheet = fs.readFileSync(\n" +
              '  path.resolve(__dirname, "../../../browser/default-stylesheet.css"),\n' +
              '  { encoding: "utf-8" }\n' +
              ");";
            if (!source.includes(needle) || !source.includes(stylesheetNeedle))
              throw new Error(
                "JSDOM stylesheet loader changed; update the bundle patch.",
              );
            return {
              contents: source
                .replace(needle, "")
                .replace(
                  stylesheetNeedle,
                  `const defaultStyleSheet = ${JSON.stringify(defaultStylesheet)};`,
                ),
              loader: "js",
            };
          },
        );
      },
    },
    {
      name: "inline-csstree-data",
      setup(build) {
        build.onLoad({ filter: /css-tree\/lib\/data-patch\.js$/ }, () => ({
          contents:
            'import patch from "../data/patch.json" with { type: "json" };\n' +
            "export default patch;\n",
          loader: "js",
        }));
        build.onLoad({ filter: /css-tree\/lib\/version\.js$/ }, () => ({
          contents:
            'import packageJson from "../package.json" with { type: "json" };\n' +
            "export const { version } = packageJson;\n",
          loader: "js",
        }));
        build.onLoad({ filter: /css-tree\/lib\/data\.js$/ }, ({ path }) => {
          const source = readFileSync(path, "utf8");
          return {
            contents: source
              .replace("import { createRequire } from 'module';\n", "")
              .replace(
                "const require = createRequire(import.meta.url);\n" +
                  "const mdnAtrules = require('mdn-data/css/at-rules.json');\n" +
                  "const mdnProperties = require('mdn-data/css/properties.json');\n" +
                  "const mdnSyntaxes = require('mdn-data/css/syntaxes.json');",
                "import mdnAtrules from 'mdn-data/css/at-rules.json' with { type: 'json' };\n" +
                  "import mdnProperties from 'mdn-data/css/properties.json' with { type: 'json' };\n" +
                  "import mdnSyntaxes from 'mdn-data/css/syntaxes.json' with { type: 'json' };",
              ),
            loader: "js",
          };
        });
      },
    },
  ];
}

/**
 * First line of every bundle the packaged Bun runs. `// @bun` marks a file as
 * already transpiled, so Bun loads it as it stands. Without it, Bun's runtime
 * transpiler re-parsed the 19 MB `server.js` at load and kept about 1.4 GB
 * alive for the module's lifetime: 1225 MB RSS at ready, against Node's 593.
 */
export const BUN_PRAGMA = "// @bun";
export const BUN_CJS_PRAGMA = "// @bun @bun-cjs";

/**
 * With no transpiler, nothing gives an ES module the `require`, `__filename`
 * and `__dirname` that esbuild's CommonJS interop still names ("Dynamic
 * require of "path" is not supported"). The banner defines them from
 * `import.meta.url`, importing its helpers under `__paBun` names.
 */
const BUN_ESM_BANNER = [
  BUN_PRAGMA,
  'import{createRequire as __paBunCreateRequire}from"node:module";' +
    'import{fileURLToPath as __paBunFileURLToPath}from"node:url";' +
    'import{dirname as __paBunDirname}from"node:path";' +
    "var require=__paBunCreateRequire(import.meta.url);" +
    "var __filename=__paBunFileURLToPath(import.meta.url);" +
    "var __dirname=__paBunDirname(__filename);",
].join("\n");

/** A pre-transpiled CommonJS file is one function expression Bun calls. */
const BUN_CJS_BANNER = [
  BUN_CJS_PRAGMA,
  "(function(exports,require,module,__filename,__dirname){",
].join("\n");
const BUN_CJS_FOOTER = "})";

// A declaration of a banner name anywhere in the bundle would shadow or
// replace the banner's (minified top-level names are short, so none exist
// today). Refuse it rather than reason about which scope it is in.
const BANNER_COLLISION =
  /\b(?:var|let|const|function|class)\s+(?:require|__filename|__dirname|__paBun\w*)\b|__paBun/;

// Keep the bundled module separate from the pinned Bun executable. Bun's
// standalone compiler encrypts its embedded module table with a random nonce,
// and its ordinary bundler orders independent modules nondeterministically.
// esbuild produces a stable module order while preserving Bun's runtime imports.
export async function bundle(entrypoint, options = {}) {
  const format = options.format ?? "esm";
  const banner = format === "cjs" ? BUN_CJS_BANNER : BUN_ESM_BANNER;
  const result = await esbuild({
    banner: { js: banner },
    ...(format === "cjs" ? { footer: { js: BUN_CJS_FOOTER } } : {}),
    bundle: true,
    entryPoints: [entrypoint],
    // Bun provides these as runtime builtins. Bundling npm's Node-targeted
    // undici calls worker_threads.markAsUncloneable, which Bun 1.3.13 does not
    // expose, while npm ws does not drive Bun's server upgrade path correctly.
    external: ["bun:*", "undici", "ws"],
    format,
    minify: true,
    platform: "node",
    plugins: options.plugins ?? [],
    target: "esnext",
    write: false,
    ...(options.define ? { define: options.define } : {}),
  });
  if (result.outputFiles.length !== 1)
    throw new Error(`Expected one bundled output for ${entrypoint}.`);
  const { contents, text } = result.outputFiles[0];
  if (!text.startsWith(`${banner}\n`))
    throw new Error(
      `${entrypoint}: esbuild did not emit the Bun banner first.`,
    );
  const collision = BANNER_COLLISION.exec(text.slice(banner.length));
  if (collision)
    throw new Error(
      `${entrypoint}: the bundle declares ${JSON.stringify(collision[0])}, a name the Bun banner defines.`,
    );
  return contents;
}
