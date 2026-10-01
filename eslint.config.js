// @ts-check
/**
 * The repo's blocking lint gate. Prettier owns formatting, so NOTHING here is
 * stylistic: every rule below either needs type information or catches a class
 * of mistake a reviewer would raise. `docs/linting.md` is the contract —
 * the ruleset, the escape-hatch policy, and what to do about a breach.
 *
 * Type-aware linting runs on TypeScript 6 (the root `typescript` devDependency)
 * because TypeScript 7's native port ships no compiler API; `tsc` — the
 * authority on what typechecks — stays on the workspace catalog's 7.x.
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import vitest from "@vitest/eslint-plugin";

export default tseslint.config(
  {
    // Generated or vendored output, plus the Rust/Tauri shell (outside the
    // pnpm workspace) and the user's live data directory.
    ignores: [
      "**/node_modules/**",
      "app/web/dist/**",
      "app/web/component-preview/dist/**",
      "app/web/component-preview/storybook-static/**",
      "app/shell/**",
      "**/assistant-data/**",
      "**/*.d.ts",
      "app/web/src/lib/pcm16Worklet.js",
    ],
  },

  // ---------------------------------------------------------------- TypeScript
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommendedTypeChecked,
      importX.flatConfigs.recommended,
      importX.flatConfigs.typescript,
    ],
    languageOptions: {
      parserOptions: {
        // One project service for the whole workspace: it picks each file's
        // owning tsconfig itself, which is what keeps 357k lines affordable.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
        }),
      ],
    },
    rules: {
      // --- forgotten `await`: the most common agent bug in this repo ---------
      "@typescript-eslint/await-thenable": "error",

      // --- the wire protocol is large discriminated unions ------------------
      // Adding a variant and missing a handler is a hard failure ONLY in a
      // switch with no `default:`. `considerDefaultExhaustiveForUnions` lets a
      // default stand in for the missing cases, which exempts precisely the
      // protocol dispatchers this rule is most wanted for — they are
      // intentionally partial and route the rest through a default.
      // Tightening it to `false` is STAGED at 18 sites / 15 files (the smallest
      // backlog here); `connection.ts` alone would need dozens of no-op cases,
      // so the count understates the work unevenly. See `docs/linting.md`.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],

      // --- `verbatimModuleSyntax` is on, so the import kind is load-bearing --
      "@typescript-eslint/no-import-type-side-effects": "error",

      // --- unused code, matching the tsconfig's noUnused* -------------------
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // --- module graph ------------------------------------------------------
      "import-x/no-duplicates": "error",
      "import-x/no-self-import": "error",
      // `../foo/../bar` and `./../x` resolve fine, so nothing breaks — but they
      // defeat grep for a module's importers and survive a move that should
      // have broken them loudly.
      "import-x/no-useless-path-segments": "error",
      // `import {} from "./x"` reads as a named import and is a bare
      // side-effect import; with `verbatimModuleSyntax` the difference is real.
      "import-x/no-empty-named-blocks": "error",
      // An exported `let` is shared mutable state across modules: importers see
      // a live binding they cannot write, and the writer is invisible from the
      // call site. Module-level state belongs behind a function.
      "import-x/no-mutable-exports": "error",
      // A cycle is a load-order hazard (a half-initialized module read during
      // evaluation) and an unstated module boundary. This rule is the
      // per-import-site DIAGNOSTIC, not the proof: a type-only import is erased
      // by `verbatimModuleSyntax` and skipped by construction, and the option
      // below is coarser than it sounds — detection abandons a module at its
      // FIRST dynamic edge, so a purely static cycle can hide behind one. knip's
      // `cycles` category (gated at zero in `config/deadcode-budgets.json`) is
      // what proves the static graph acyclic. The option is set because the four
      // modules reaching `hub.ts` back lazily do it to KEEP that graph acyclic;
      // tightening it to `false` is STAGED at 49 sites / 46 files.
      // `docs/linting.md` carries the measurement and what tightening takes.
      "import-x/no-cycle": [
        "error",
        { allowUnsafeDynamicCyclicDependency: true },
      ],
      // Module RESOLUTION is tsc's job and it is stricter here (NodeNext
      // exports maps, `?worker` queries, CJS default interop); import-x only
      // produces false positives for those.
      "import-x/no-unresolved": "off",
      "import-x/default": "off",
      "import-x/namespace": "off",
      "import-x/no-named-as-default": "off",
      "import-x/no-named-as-default-member": "off",

      // --- correctness the type checker does not cover -----------------------
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-constant-binary-expression": "error",
      // A `let` read by a closure BEFORE its single assignment cannot be const.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // A `case` carrying only comments is not a fallthrough; real ones are
      // caught by tsc's `noFallthroughCasesInSwitch` as well.
      "no-fallthrough": ["error", { allowEmptyCase: true }],
      // `x === x` is either dead weight or a botched NaN check.
      "no-self-compare": "error",
      // "${id}" in a plain-quoted string: a template that never interpolated.
      "no-template-curly-in-string": "error",
      // `.map`/`.filter`/`.reduce` with a callback that falls off the end
      // yields `undefined` for every element — a silent all-`undefined` array
      // or an all-pass filter.
      "array-callback-return": "error",
      // A loop body that always exits on the first iteration is a `for` that
      // meant to be an `if`, or a misplaced `return`.
      "no-unreachable-loop": "error",
      // `return` in a constructor silently replaces the instance `new` hands
      // back, so the class's own initialization is discarded.
      "no-constructor-return": "error",
      // A `default:` before the last `case` still runs last, so the cases after
      // it read as unreachable when they are not.
      "default-case-last": "error",
      // `return (a = b)` is an assignment typo'd into a return value.
      "no-return-assign": "error",
      "@typescript-eslint/no-array-delete": "error",
      "@typescript-eslint/no-duplicate-type-constituents": "error",
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-meaningless-void-operator": "error",
      "@typescript-eslint/no-mixed-enums": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/only-throw-error": "error",
      // A getter and setter of the same name with different types make
      // `obj.x = obj.x` a type error waiting to happen.
      "@typescript-eslint/related-getter-setter-pairs": "error",
      // A parameter with a default before a required one can never be omitted,
      // so the default is unreachable and the signature lies.
      "@typescript-eslint/default-param-last": "error",
      // `a! ?? b` and `a?.b!` each assert non-null right where the code just
      // said the value may be missing: the fallback and the guard are dead.
      "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
      // `this` is the only return type that survives subclassing.
      "@typescript-eslint/prefer-return-this-type": "error",
      // `export {}` forces a file to be a module; with ESM everywhere it is
      // left-over scaffolding.
      "@typescript-eslint/no-useless-empty-export": "error",
      // A type argument spelled out as its own default drifts when the default
      // changes and hides that it did.
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      // Only the cases where the `await` CHANGES behaviour: inside `try` (and
      // under `using`), returning a promise without awaiting it escapes the
      // `catch`/`finally` entirely. Elsewhere the `await` is a style call this
      // repo does not make — the default and `always` are NOT clean here.
      "@typescript-eslint/return-await": [
        "error",
        "error-handling-correctness-only",
      ],
      // `catch (err) { reject(err) }` is correct propagation and wrapping it
      // would bury the original, so `unknown` is allowed through. Note this is
      // broader than that case: it permits ANY `unknown`/`any`-typed value, and
      // with the `no-unsafe-*` family staged off, `any` reaches here freely.
      // Rejecting with a freshly-made non-Error is still an error.
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingUnknown: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],

      // --- a promise nobody waits for ---------------------------------------
      // A floating rejection is an unhandled one; an `async` function passed
      // where a void-returning one is expected rejects into nothing at all.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      /* ------------------------- STAGED, NOT YET ON -------------------------
       * These are the rules this change set out to make blocking. Each is a
       * real signal, and turning one on means clearing its list, not silencing
       * it. Adopt them one rule per change — smallest JOB first, which is not
       * the same as smallest count — and delete the line when it reaches zero.
       *
       * A count is a measurement ANCHORED TO A COMMIT, not a current fact: all
       * of these were re-measured at b887a1f2 and they drift upward as the
       * codebase grows. Treat them as planning aids and re-measure the one you
       * are about to adopt. `docs/linting.md` carries the plan and says which
       * entries are larger jobs than their number suggests.
       *
       * The trailing `no-unnecessary-condition` line is NOT one of these: it is
       * rejected, not queued, and it sits here only so the rule has one home.
       */
      "@typescript-eslint/require-await": "off", // 1091
      "@typescript-eslint/no-unsafe-member-access": "off", // 892
      "@typescript-eslint/no-unsafe-assignment": "off", // 646
      "@typescript-eslint/no-unnecessary-type-assertion": "off", // 556 (and its
      // autofix is unsound here: it runs on TypeScript 6 and removed
      // assertions TypeScript 7 still needs).
      "@typescript-eslint/no-explicit-any": "off", // 268
      "@typescript-eslint/no-base-to-string": "off", // 160
      "@typescript-eslint/consistent-type-imports": "off", // 134
      "@typescript-eslint/no-unsafe-argument": "off", // 107
      "@typescript-eslint/no-unsafe-call": "off", // 60
      "@typescript-eslint/no-unsafe-return": "off", // 49
      "@typescript-eslint/unbound-method": "off", // 43
      "preserve-caught-error": "off", // 34
      // `no-unnecessary-condition` is off and stays off: 877 sites, and its
      // sharpest findings are runtime guards at trust boundaries that the type
      // system only believes because of an `as` cast. See `docs/linting.md`.
      "@typescript-eslint/no-unnecessary-condition": "off", // 877, not adoptable
      "@typescript-eslint/no-deprecated": "off", // 12: nine intentional
      // browser-compat fallbacks and three deferred MCP SDK migration sites.
      "no-useless-assignment": "off", // 19
      // `import-x/no-cycle` is ON above; only its
      // `allowUnsafeDynamicCyclicDependency: false` tightening is staged, at 49
      // sites / 46 files, all of them chains through one of the four lazy
      // `await import("./hub.ts")` seams. Those 49 are not unfixed cycles, and
      // acyclicity does not wait on them: knip's `cycles` gate proves it today.
    },
  },

  // ------------------------------------------------------------------- React
  {
    files: ["app/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",

      // --- render must be a pure function of props and state ----------------
      // Setting state during render is an infinite loop or a wasted pass; the
      // React compiler's analysis finds the indirect cases a reviewer misses.
      "react-hooks/set-state-in-render": "error",
      // A component defined inside another component is a NEW type on every
      // render, so React unmounts and remounts it and its state is lost. This
      // also covers a component built by a factory called during render, which
      // the removed `component-hook-factories` rule used to report separately —
      // that name is a deprecated no-op in v7 and must NOT be re-added.
      "react-hooks/static-components": "error",
      // An error boundary must be a class with `componentDidCatch`/
      // `getDerivedStateFromError`; a hook cannot catch a render error.
      "react-hooks/error-boundaries": "error",
      // Calling time/random/browser mutation APIs during render makes the same
      // inputs produce a different tree and can remount keyed rows.
      "react-hooks/purity": "error",
      // Reading a closure before its declaration freezes the earlier value for
      // the compiler instead of letting later renders update it.
      "react-hooks/immutability": "error",

      // Mirrored props, cache-key changes, and authoritative server echoes each
      // need a state-ownership decision rather than an effect deletion.
      "react-hooks/no-deriving-state-in-effects": "off", // 3

      // --- memoization that actually holds ----------------------------------
      "react-hooks/use-memo": "error",
      // `useMemo(() => { ... })` with a body that returns nothing memoizes
      // `undefined` — the work runs every render and the value is gone.
      "react-hooks/void-use-memo": "error",
      // An effect depending on a value the compiler memoized differently than
      // the dep array claims re-runs, or fails to, at the wrong times.
      "react-hooks/memoized-effect-dependencies": "error",
      "react-hooks/exhaustive-effect-dependencies": "error",

      // --- the compiler's own preconditions ---------------------------------
      // These fire when a file uses a library or syntax the React compiler
      // cannot reason about, or misconfigures its gating: silent unsoundness
      // in every rule above, so they are errors, not warnings.
      "react-hooks/incompatible-library": "error",
      "react-hooks/unsupported-syntax": "error",
      "react-hooks/config": "error",
      "react-hooks/gating": "error",
    },
  },

  // ------------------------------------------------------------------ Vitest
  {
    files: ["**/*.test.{ts,tsx}", "**/*.e2e.test.ts", "**/test/**/*.ts"],
    plugins: { vitest },
    rules: {
      // A stray `.only` silently disables the rest of a file, invisibly to CI.
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/no-identical-title": "error",

      // --- an assertion that never asserts ----------------------------------
      // `expect(x)` with no matcher, or `expect(x).resolves` never awaited,
      // passes silently. `maxArgs: 2` is load-bearing: Vitest's
      // `expect(value, message)` is real API and this repo uses it, so the
      // default of 1 would flag legitimate call sites.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/valid-expect-in-promise": "error",
      // An `expect` outside `it`/`test` runs at collection time, where a
      // failure is a suite-level error rather than a failing test.
      "vitest/no-standalone-expect": "error",
      // `expect.poll` returns a promise; unawaited it asserts nothing.
      "vitest/require-awaited-expect-poll": "error",
      // An `async` matcher callback that awaits nothing hides that the
      // assertion is synchronous.
      "vitest/no-unneeded-async-expect-function": "error",
      // A commented-out test is a test nobody runs and nobody deletes.
      "vitest/no-commented-out-tests": "error",
      // Jest aliases (`toBeCalledWith`, `toThrowError`, ...) resolve to the
      // canonical matcher; one spelling keeps them greppable.
      "vitest/no-alias-methods": "error",
      // `vi.mocked(fn)` types the mock; a hand-written cast does not.
      "vitest/prefer-vi-mocked": "error",
      // Two `beforeEach` in one describe both run, in source order — almost
      // always a merge that dropped one's intent.
      "vitest/no-duplicate-hooks": "error",

      // Hidden helper assertions and former standalone scripts whose assertions
      // still run during module evaluation need a test-architecture migration.
      "vitest/expect-expect": "off", // 38
    },
  },

  // ------------------------------------------------- repo scripts (plain JS)
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },

  // ------------------------------------------- service worker (browser, plain JS)
  // Shipped to production but outside `app/web/src`, so the TypeScript block
  // above never saw it. `pcm16Worklet.js` stays ignored: it runs on the audio
  // render thread, whose globals are its own.
  {
    files: ["app/web/public/sw.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        caches: "readonly",
        clients: "readonly",
        fetch: "readonly",
        Response: "readonly",
        self: "readonly",
        skipWaiting: "readonly",
        URL: "readonly",
      },
    },
  },

  {
    linterOptions: {
      // An `eslint-disable` that no longer suppresses anything is itself a bug.
      reportUnusedDisableDirectives: "error",
    },
  },
);
