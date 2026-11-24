import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  mkdtemp,
  mkdir,
  lstat,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  linkEntryChild,
  setRecreateEntrySymlinksForTests,
  withEntryChild,
  withLibraryRoot,
} from "./entrySource.ts";

let afterCreate: ((path: string) => Promise<void>) | undefined;
let refuseDestinationPin = false;
let volfsError: string | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    symlink: async (...args: Parameters<typeof actual.symlink>) => {
      await actual.symlink(...args);
      const hook = afterCreate;
      afterCreate = undefined;
      await hook?.(String(args[1]));
    },
    lstat: (...args: Parameters<typeof actual.lstat>) => {
      if (volfsError && String(args[0]).startsWith("/.vol/")) {
        return Promise.reject(
          Object.assign(new Error("injected volfs failure"), {
            code: volfsError,
          }),
        );
      }
      return actual.lstat(...args);
    },
    open: (...args: Parameters<typeof actual.open>) => {
      if (refuseDestinationPin && String(args[0]).endsWith("/renamed.md")) {
        return Promise.reject(
          Object.assign(new Error("injected EMFILE"), { code: "EMFILE" }),
        );
      }
      return actual.open(...args);
    },
  };
});

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "library-link-test-"));
  await mkdir(join(root, "destination"));
  await writeFile(join(root, "outside.txt"), "Do not modify.\n");
  // Exercise the Darwin copy policy on Linux CI too.
  setRecreateEntrySymlinksForTests(true);
});

afterEach(async () => {
  afterCreate = undefined;
  refuseDestinationPin = false;
  volfsError = undefined;
  setRecreateEntrySymlinksForTests(null);
  await rm(root, { recursive: true, force: true });
});

async function carry(source = "source.md", name = "renamed.md") {
  return withLibraryRoot(root, (from) =>
    withEntryChild(from, "destination", async (to) => {
      const pin = await linkEntryChild(from, source, to.handle, name);
      try {
        return {
          source: pin.sourceIdentity,
          destination: pin.identity,
          separateSourcePin: pin.source !== undefined,
        };
      } finally {
        await pin.handle.close();
        await pin.source?.handle.close();
      }
    }),
  );
}

test("recreates symlink target bytes without opening or modifying its target", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  const carried = await carry();
  const destination = join(root, "destination", "renamed.md");
  assert.equal(await readlink(destination), "outside.txt");
  assert.equal((await lstat(destination)).ino, carried.destination.ino);
  assert.notEqual(carried.destination.ino, carried.source.ino);
  assert.equal(
    await readFile(join(root, "outside.txt"), "utf8"),
    "Do not modify.\n",
  );
  assert.deepEqual(await readdir(join(root, "destination")), ["renamed.md"]);
});

test("copies dangling symlinks", async () => {
  await symlink("missing.txt", join(root, "source.md"));
  await carry();
  assert.equal(
    await readlink(join(root, "destination", "renamed.md")),
    "missing.txt",
  );
});

test("copies non-UTF-8 targets byte-for-byte", async () => {
  const target = Buffer.from([0x66, 0xff, 0x20, 0x0a]);
  await symlink(target, join(root, "source.md"));
  await carry();
  assert.deepEqual(
    await readlink(join(root, "destination", "renamed.md"), {
      encoding: "buffer",
    }),
    target,
  );
});

test("never replaces an occupied destination file", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  const destination = join(root, "destination", "renamed.md");
  await writeFile(destination, "User content.\n");
  await assert.rejects(carry(), /already exists/);
  assert.equal(await readFile(destination, "utf8"), "User content.\n");
});

test("an occupied directory is a collision, not a request to create inside it", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  const destination = join(root, "destination", "renamed.md");
  await mkdir(destination);
  await assert.rejects(carry(), /already exists/);
  assert.deepEqual(await readdir(destination), []);
});

test("an occupied symlink to a directory is never followed", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  const outside = join(root, "outside");
  await mkdir(outside);
  await symlink(outside, join(root, "destination", "renamed.md"));
  await assert.rejects(carry(), /already exists/);
  assert.deepEqual(await readdir(outside), []);
});

test("a destination replaced after creation is refused and left untouched", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  const outside = join(root, "outside");
  await mkdir(outside);
  afterCreate = async (path) => {
    await rm(path);
    await symlink(outside, path);
  };
  await assert.rejects(carry(), /replaced/);
  assert.equal(
    await readlink(join(root, "destination", "renamed.md")),
    outside,
  );
  assert.deepEqual(await readdir(outside), []);
});

test("a recreated symlink whose destination pin fails is taken back", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  refuseDestinationPin = true;
  await assert.rejects(carry(), { code: "EMFILE" });
  assert.deepEqual(await readdir(join(root, "destination")), []);
  assert.equal(await readlink(join(root, "source.md")), "outside.txt");
});

test("pin failure never takes back a foreign replacement with different target bytes", async () => {
  await symlink("outside.txt", join(root, "source.md"));
  afterCreate = async (path) => {
    await rm(path);
    await symlink("foreign-target", path);
    refuseDestinationPin = true;
  };
  await assert.rejects(carry(), { code: "EMFILE" });
  assert.equal(
    await readlink(join(root, "destination", "renamed.md")),
    "foreign-target",
  );
  assert.deepEqual(await readdir(join(root, "destination")), ["renamed.md"]);
});

test.skipIf(process.platform !== "darwin")(
  "unsupported volumes report a root-level filesystem error, not a missing manifest",
  async () => {
    volfsError = "ENOENT";
    await assert.rejects(
      withLibraryRoot(root, async () => undefined),
      /filesystem does not support inode-anchored library access/,
    );
  },
);

test.skipIf(process.platform !== "darwin").each(["EMFILE", "EACCES", "EINTR"])(
  "volfs %s is not misreported as an unsupported filesystem",
  async (code) => {
    volfsError = code;
    await assert.rejects(
      withLibraryRoot(root, async () => undefined),
      { code },
    );
  },
);

test("ordinary files remain hard links with the same inode on both sides", async () => {
  const carried = await carry("outside.txt");
  assert.deepEqual(carried.destination, carried.source);
  assert.equal(carried.separateSourcePin, false);
  assert.equal(
    await readFile(join(root, "destination", "renamed.md"), "utf8"),
    "Do not modify.\n",
  );
});

test.skipIf(process.platform !== "linux")(
  "Linux's default policy still hard-links symlinks",
  async () => {
    setRecreateEntrySymlinksForTests(null);
    await symlink("outside.txt", join(root, "source.md"));
    const carried = await carry();
    assert.deepEqual(carried.destination, carried.source);
    assert.equal(carried.separateSourcePin, false);
  },
);
