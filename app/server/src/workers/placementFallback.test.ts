import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import {
  APP_SETTINGS_PATH,
  readStoredAppSettings,
} from "../appSettingsFile.ts";
import { git } from "../gitExec.ts";
import { knowledgeBaseSettingsProjection } from "../knowledgeBaseSettings.ts";
import { inProcessWorkerServedForTests } from "./inProcessWorker.ts";
import { DATA_DIR } from "../config.ts";
import { DEFAULT_WORKER_ID, placeServedPath } from "./placement.ts";

const scratch = mkdtempSync(join(tmpdir(), "placement-fallback-"));
const defaultRoot = knowledgeBaseSettingsProjection(undefined).effectivePath;
mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });
const savedMode = process.env.ASSISTANT_SPAWN_BROKER;
let ownsDefaultLink = false;
let ownsSettings = false;
function settings(text: string): void {
  if (!ownsSettings) {
    // Exclusive creation refuses any pre-existing settings file or symlink.
    writeFileSync(APP_SETTINGS_PATH, text, { flag: "wx" });
    ownsSettings = true;
    return;
  }
  const next = `${APP_SETTINGS_PATH}.next`;
  writeFileSync(next, text, { flag: "wx" });
  renameSync(next, APP_SETTINGS_PATH);
}
const configured = (path: string) =>
  JSON.stringify({ knowledgeBase: { path } });
const onWorker = (path: string) => ({ workerId: DEFAULT_WORKER_ID, path });

afterEach(() => {
  vi.restoreAllMocks();
  if (savedMode === undefined) delete process.env.ASSISTANT_SPAWN_BROKER;
  else process.env.ASSISTANT_SPAWN_BROKER = savedMode;
  if (ownsSettings) {
    rmSync(APP_SETTINGS_PATH, { force: true });
    ownsSettings = false;
  }
  if (ownsDefaultLink) {
    // Never remove a pre-existing default KB if link creation failed.
    unlinkSync(defaultRoot);
    ownsDefaultLink = false;
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const mode of ["broker", "in-process"]) {
  describe(mode, () => {
    test("served files under known and default KB aliases stay local through settings failure and recovery", async () => {
      process.env.ASSISTANT_SPAWN_BROKER = mode === "broker" ? "1" : "0";
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const real = join(scratch, mode, "real-notes");
      const alias = join(scratch, mode, "notes");
      const defaultReal = join(scratch, mode, "default-notes");
      const other = join(scratch, mode, "checkout");
      for (const dir of [real, defaultReal, other])
        mkdirSync(join(dir, "sub"), { recursive: true });
      symlinkSync(real, alias);
      symlinkSync(defaultReal, defaultRoot);
      ownsDefaultLink = true;
      settings(configured(alias));
      assert.equal(
        placeServedPath(alias),
        undefined,
        "remember a successful root and its real path",
      );
      assert.deepEqual(
        placeServedPath(defaultReal),
        onWorker(defaultReal),
        "readable custom settings are authoritative",
      );
      settings("{ not json");
      for (const path of [alias, real, defaultRoot, defaultReal]) {
        assert.equal(placeServedPath(path), undefined, path);
        assert.equal(placeServedPath(`${path}/sub/../sub`), undefined);
        assert.equal(
          placeServedPath(join(path, "not-created", "nested")),
          undefined,
        );
      }
      assert.equal(
        warning.mock.calls.length,
        1,
        "one warning for all fallback calls",
      );
      assert.throws(
        () => readStoredAppSettings(),
        /Failed to read app settings/,
      );
      // `${defaultRoot}-old` lies in DATA_DIR, local by that rule alone.
      for (const path of [other, `${alias}-old`])
        assert.deepEqual(placeServedPath(path), onWorker(path));
      // Checkout git reads no KB setting: a bare cwd in the KB is a checkout.
      const before = inProcessWorkerServedForTests();
      for (const cwd of [alias, real, defaultReal, other])
        assert.match((await git(["--version"], cwd)).stdout, /^git version/);
      assert.equal(inProcessWorkerServedForTests() - before, 4);
      assert.equal(warning.mock.calls.length, 1);

      rmSync(alias);
      unlinkSync(defaultRoot);
      ownsDefaultLink = false;
      assert.equal(
        placeServedPath(real),
        undefined,
        "retain the known real path when its alias disappears",
      );
      assert.equal(
        placeServedPath(defaultReal),
        undefined,
        "retain the observed default real path too",
      );
      settings("{ still broken");
      assert.equal(placeServedPath(real), undefined);
      assert.equal(
        warning.mock.calls.length,
        1,
        "changing the error does not start a new episode",
      );

      const replacement = join(scratch, mode, "replacement");
      mkdirSync(replacement);
      settings(configured(replacement));
      assert.equal(placeServedPath(replacement), undefined);
      // The default root itself lives in DATA_DIR, local by that rule alone.
      for (const path of [alias, real, defaultReal])
        assert.deepEqual(
          placeServedPath(path),
          onWorker(path),
          "do not keep obsolete roots when settings are readable",
        );

      settings("{ broken again");
      assert.equal(
        placeServedPath(replacement),
        undefined,
        "a failed read cannot poison the new last-successful root",
      );
      assert.equal(placeServedPath(defaultReal), undefined);
      assert.deepEqual(
        placeServedPath(real),
        onWorker(real),
        "failure retains only the most recent custom root",
      );
      assert.equal(warning.mock.calls.length, 2);
      const missing = join(scratch, mode, "not-created");
      settings(configured(missing));
      assert.equal(placeServedPath(join(missing, "nested")), undefined);
      settings("{ broken once more");
      assert.equal(
        placeServedPath(join(missing, "nested")),
        undefined,
        "a nonexistent root still matches lexically",
      );
      assert.equal(warning.mock.calls.length, 3);
    });

    test("fallback warning resets after any successful settings read", async () => {
      process.env.ASSISTANT_SPAWN_BROKER = mode === "broker" ? "1" : "0";
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const outside = join(scratch, mode, "warning-checkout");
      mkdirSync(outside, { recursive: true });
      const served = join(outside, "page.md");
      settings("{}");
      assert.deepEqual(placeServedPath(served), onWorker(served));
      settings("{ not json");
      // Checkout git reads no KB setting and so never warns (E-W3c-2).
      for (let i = 0; i < 3; i++) await git(["--version"], outside);
      assert.equal(warning.mock.calls.length, 0);
      for (let i = 0; i < 3; i++) placeServedPath(served);
      assert.equal(warning.mock.calls.length, 1);
      assert.match(
        String(warning.mock.calls[0]?.[0]),
        /Knowledge Base settings unavailable.*for served files/,
      );
      assert.ok(
        !String(warning.mock.calls[0]?.[0]).includes(APP_SETTINGS_PATH),
        "do not log raw settings paths/errors",
      );
      settings("{}");
      placeServedPath(served);
      settings("{ not json");
      for (let i = 0; i < 3; i++) placeServedPath(served);
      assert.equal(warning.mock.calls.length, 2);
    });
  });
}

test("served files keep the Knowledge Base path rule through settings failure", () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const real = join(scratch, "served", "real-notes");
  const alias = join(scratch, "served", "notes");
  const defaultReal = join(scratch, "served", "default-notes");
  const other = join(scratch, "served", "checkout");
  for (const dir of [real, defaultReal, other])
    mkdirSync(join(dir, "sub"), { recursive: true });
  symlinkSync(real, alias);
  symlinkSync(defaultReal, defaultRoot);
  ownsDefaultLink = true;
  settings(configured(alias));
  assert.equal(placeServedPath(join(alias, "page.md")), undefined);
  settings("{ not json");
  for (const path of [alias, real, defaultReal].flatMap((root) => [
    root,
    join(root, "page.md"),
    join(root, "not-created", "page.md"),
  ]))
    assert.equal(placeServedPath(path), undefined, path);
  for (const path of [join(other, "page.md"), `${alias}-old/page.md`])
    assert.deepEqual(placeServedPath(path), onWorker(path), path);
  // The default root lives in DATA_DIR, which stays local by itself.
  assert.ok(defaultRoot.startsWith(`${DATA_DIR}/`));
  assert.equal(placeServedPath(join(defaultRoot, "page.md")), undefined);
});

/** One GET through the worktree API handler of the module graph given. */
async function get(
  handle: typeof import("../worktrees/worktreeHttp.ts").handleWorktreeApi,
  path: string,
): Promise<{ status: number; body: { error?: string } }> {
  let status = 0;
  let text = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string | Buffer) {
      text = String(chunk ?? "");
    },
  } as unknown as ServerResponse;
  const req = { method: "GET" } as unknown as IncomingMessage;
  await handle(req, res, new URL(`http://x${path}`), () => ({}));
  return { status, body: JSON.parse(text) as { error?: string } };
}

test("checkout git and reads read no KB setting, from a cold start with settings unreadable", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  // A project's checkout at the custom KB root nobody can read any more.
  const custom = join(scratch, "cold", "custom-notes");
  mkdirSync(custom, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: custom });
  writeFileSync(join(custom, "page.md"), "page\n");
  settings(configured(custom));
  settings("{ not json");
  vi.resetModules();
  let placementReads = 0;
  vi.doMock("../knowledgeBaseSettings.ts", async (importActual) => {
    const actual =
      await importActual<typeof import("../knowledgeBaseSettings.ts")>();
    return {
      ...actual,
      knowledgeBasePlacementRoots: () => {
        placementReads += 1;
        return actual.knowledgeBasePlacementRoots();
      },
    };
  });
  try {
    const checkoutGit = await import("../gitExec.ts");
    const files = await import("../checkoutFileAccess.ts");
    const { checkoutSideOf } =
      await import("../worktrees/knowledgeCheckout.ts");
    const { handleWorktreeApi } = await import("../worktrees/worktreeHttp.ts");
    const { inProcessWorkerServedForTests: served } =
      await import("./inProcessWorker.ts");

    let before = served();
    const top = await checkoutGit.gitOptional(
      ["rev-parse", "--show-toplevel"],
      custom,
    );
    assert.equal(top.code, 0, top.stderr);
    assert.equal(served() - before, 1, "string git runs on the Worker");
    const project = checkoutSideOf({ id: "main:notes" });
    assert.deepEqual(project, { workerId: DEFAULT_WORKER_ID });
    before = served();
    assert.equal(
      (await checkoutGit.checkoutGitOn(project).gitOptional(["status"], custom))
        .code,
      0,
    );
    assert.equal(served() - before, 1, "a project's side is the Worker");
    before = served();
    const page = join(custom, "page.md");
    assert.equal(await files.checkoutPathExists(custom, page), true);
    assert.equal(
      (await files.readCheckoutFile(custom, page)).toString(),
      "page\n",
    );
    assert.ok(served() - before >= 2, "checkout reads run on the Worker");

    // The KB itself fails as in base: its row cannot be resolved.
    before = served();
    const kb = await get(handleWorktreeApi, "/api/worktrees/knowledge/status");
    assert.equal(kb.status, 500);
    assert.match(kb.body.error ?? "", /Failed to read app settings/);
    assert.equal(served(), before, "the KB surface sends the Worker nothing");

    assert.equal(placementReads, 0, "checkout placement reads no setting");
    assert.equal(warning.mock.calls.length, 0);
  } finally {
    vi.doUnmock("../knowledgeBaseSettings.ts");
    vi.resetModules();
  }
});
