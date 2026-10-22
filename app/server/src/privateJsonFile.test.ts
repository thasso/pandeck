import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createPrivateJsonFile } from "./privateJsonFile.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    chmodSync: vi.fn(actual.chmodSync),
    writeFileSync: vi.fn(actual.writeFileSync),
    renameSync: vi.fn(actual.renameSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

let directory: string;
let path: string;

beforeEach(() => {
  vi.clearAllMocks();
  directory = fs.mkdtempSync(join(tmpdir(), "private-json-file-"));
  path = join(directory, "settings", "example.json");
});

afterEach(() => {
  vi.resetAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("normalizes missing and parsed files without caching", () => {
  const file = createPrivateJsonFile(path, "Example settings");
  const normalize = vi.fn((value: { enabled?: boolean } | undefined) => ({
    enabled: value?.enabled === true,
  }));
  assert.deepEqual(file.read(normalize), { enabled: false });
  assert.deepEqual(normalize.mock.calls, [[undefined]]);
  file.write({ enabled: true });
  assert.deepEqual(file.read(normalize), { enabled: true });
  file.write(null);
  assert.deepEqual(file.read(normalize), { enabled: false });
  assert.equal(normalize.mock.calls[2]?.[0], null);
});

test("names corrupt files without quoting their contents", () => {
  fs.mkdirSync(join(directory, "settings"));
  fs.writeFileSync(path, '{"token":"fake-secret", broken');
  const file = createPrivateJsonFile(path, "Example settings");
  assert.throws(() => file.read((value) => value), {
    message: `Failed to read Example settings at ${path}: the file is not valid JSON`,
  });
});

test("keeps the named error for normalization failures", () => {
  const file = createPrivateJsonFile(path, "Example config");
  file.write({});
  assert.throws(
    () =>
      file.read(() => {
        throw new Error("invalid setting");
      }),
    { message: `Failed to read Example config at ${path}: invalid setting` },
  );
});

for (const staleTemp of [false, true]) {
  test(`writes owner-only before secrets reach disk, stale temp: ${staleTemp}`, async () => {
    const actual = await vi.importActual<typeof fs>("node:fs");
    if (staleTemp) {
      fs.mkdirSync(join(directory, "settings"));
      fs.writeFileSync(path, "{}\n");
      fs.chmodSync(path, 0o644);
      fs.writeFileSync(`${path}.tmp`, "{}\n");
      fs.chmodSync(`${path}.tmp`, 0o644);
    }
    const modes: number[] = [];
    vi.mocked(fs.writeFileSync).mockImplementationOnce(
      (target, data, options) => {
        assert.equal(typeof target, "number");
        modes.push(fs.fstatSync(target as number).mode & 0o777);
        actual.writeFileSync(target, data, options);
      },
    );
    const previous = process.umask(0o022);
    try {
      createPrivateJsonFile(path, "Example settings").write({
        token: "fake-secret",
      });
    } finally {
      process.umask(previous);
    }
    assert.deepEqual(modes, [0o600]);
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(path, "utf8"),
      '{\n  "token": "fake-secret"\n}\n',
    );
    assert.equal(fs.existsSync(`${path}.tmp`), false);
  });
}

for (const privateDirectory of [undefined, "create", "enforce"] as const) {
  for (const existing of [false, true]) {
    test(`directory privacy ${privateDirectory ?? "default"}, existing: ${existing}`, async () => {
      const actual = await vi.importActual<typeof fs>("node:fs");
      const parent = join(directory, "settings");
      if (existing) {
        fs.mkdirSync(parent);
        fs.chmodSync(parent, 0o755);
      }
      const expectedMode =
        privateDirectory === "enforce" ||
        (privateDirectory === "create" && !existing)
          ? 0o700
          : 0o755;
      vi.mocked(fs.writeFileSync).mockImplementationOnce(
        (target, data, options) => {
          assert.equal(fs.statSync(parent).mode & 0o777, expectedMode);
          actual.writeFileSync(target, data, options);
        },
      );
      const previous = process.umask(0o022);
      try {
        createPrivateJsonFile(
          path,
          "Example settings",
          privateDirectory ? { privateDirectory } : {},
        ).write({ enabled: true });
      } finally {
        process.umask(previous);
      }
      assert.equal(fs.statSync(parent).mode & 0o777, expectedMode);
    });
  }
}

test("does not write when enforcing directory privacy fails", () => {
  const file = createPrivateJsonFile(path, "Example settings", {
    privateDirectory: "enforce",
  });
  vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
    throw new Error("chmod failed");
  });
  assert.throws(() => file.write({ token: "fake-secret" }), /chmod failed/);
  assert.equal(vi.mocked(fs.writeFileSync).mock.calls.length, 0);
  assert.equal(vi.mocked(fs.renameSync).mock.calls.length, 0);
  assert.equal(fs.existsSync(`${path}.tmp`), false);
});

test("retains compact JSON with a trailing newline when requested", () => {
  createPrivateJsonFile(path, "Example cache", { compact: true }).write({
    nested: { count: 1 },
  });
  assert.equal(fs.readFileSync(path, "utf8"), '{"nested":{"count":1}}\n');
});

test("replaces the destination only after a complete, closed temp file", async () => {
  const actual = await vi.importActual<typeof fs>("node:fs");
  const file = createPrivateJsonFile(path, "Example settings");
  file.write({ version: 1 });
  const oldContents = fs.readFileSync(path, "utf8");
  const oldFd = fs.openSync(path, "r");
  vi.mocked(fs.closeSync).mockClear();
  vi.mocked(fs.renameSync).mockImplementationOnce((source, destination) => {
    assert.equal(fs.readFileSync(path, "utf8"), oldContents);
    assert.equal(fs.readFileSync(source, "utf8"), '{\n  "version": 2\n}\n');
    assert.equal(vi.mocked(fs.closeSync).mock.calls.length, 1);
    const closedFd = vi.mocked(fs.closeSync).mock.calls[0]![0];
    assert.throws(() => fs.fstatSync(closedFd), { code: "EBADF" });
    actual.renameSync(source, destination);
  });
  try {
    file.write({ version: 2 });
    assert.equal(fs.readFileSync(oldFd, "utf8"), oldContents);
    assert.deepEqual(
      file.read((value) => value),
      { version: 2 },
    );
  } finally {
    fs.closeSync(oldFd);
  }
});

test("closes the temp file and preserves the destination after a failed write", () => {
  const file = createPrivateJsonFile(path, "Example settings");
  file.write({ version: 1 });
  const oldContents = fs.readFileSync(path, "utf8");
  vi.mocked(fs.renameSync).mockClear();
  vi.mocked(fs.closeSync).mockClear();
  vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
    throw new Error("write failed");
  });
  assert.throws(() => file.write({ version: 2 }), /write failed/);
  assert.equal(fs.readFileSync(path, "utf8"), oldContents);
  assert.equal(vi.mocked(fs.renameSync).mock.calls.length, 0);
  assert.equal(vi.mocked(fs.closeSync).mock.calls.length, 1);
  const fd = vi.mocked(fs.closeSync).mock.calls[0]![0];
  assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
});
