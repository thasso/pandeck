import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  checkHostTool,
  checkHostTools,
  compareVersions,
  hostToolFailureReport,
  hostToolRequirements,
  parseVersion,
  resetHostToolsCache,
  verifyRequiredHostTools,
} from "./hostTools.ts";

/**
 * The committed table's probes are GNU-shaped (`env --version`, bash >= 5) and
 * the deploy target is x86_64-linux, so the assertions that measure THIS machine
 * only mean anything on Linux. On macOS `env` prints a usage line and the system
 * bash is 3.2 — which is exactly why the production check is fatal and the dev
 * one only warns.
 */
const onLinux = process.platform === "linux";

const tmpDirs: string[] = [];

/** A tiny executable that prints `text` on the requested stream. */
function fakeTool(name: string, text: string, stream = "1"): string {
  const dir = mkdtempSync(join(tmpdir(), "host-tools-"));
  tmpDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${text}" >&${stream}\n`);
  chmodSync(path, 0o755);
  return dir;
}

/** An empty PATH dir, tracked for cleanup like fakeTool's. */
function emptyDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const originalPath = process.env.PATH;
const originalTable = process.env.ASSISTANT_HOST_TOOLS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalTable === undefined) delete process.env.ASSISTANT_HOST_TOOLS;
  else process.env.ASSISTANT_HOST_TOOLS = originalTable;
  resetHostToolsCache();
  while (tmpDirs.length > 0)
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("parseVersion", () => {
  it("takes the first dotted number out of real version banners", () => {
    assert.equal(
      parseVersion("GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)"),
      "5.3.15",
    );
    assert.equal(parseVersion("env (GNU coreutils) 9.11"), "9.11");
    assert.equal(parseVersion("git version 2.55.0"), "2.55.0");
  });

  it("is undefined when there is no number at all", () => {
    assert.equal(parseVersion("no version here"), undefined);
  });
});

describe("compareVersions", () => {
  it("compares component-wise rather than lexically", () => {
    assert.ok(compareVersions("5.10", "5.9") > 0);
    assert.ok(compareVersions("9.0", "10.0") < 0);
    assert.equal(compareVersions("5.3.15", "5.3.15"), 0);
  });

  it("treats missing components as zero", () => {
    assert.equal(compareVersions("5", "5.0.0"), 0);
    assert.ok(compareVersions("5.0.1", "5") > 0);
  });
});

describe("checkHostTool", () => {
  const requirement = {
    binary: "faketool",
    minVersion: "5.0",
    versionArgs: ["--version"],
    reason: "test",
  };

  it("passes when the tool is new enough", () => {
    process.env.PATH = fakeTool("faketool", "faketool 5.3.15");
    const check = checkHostTool(requirement);
    assert.equal(check.ok, true);
    assert.equal(check.version, "5.3.15");
  });

  it("fails, and says so, when the tool is too old", () => {
    process.env.PATH = fakeTool("faketool", "faketool 4.9");
    const check = checkHostTool(requirement);
    assert.equal(check.ok, false);
    assert.match(check.problem ?? "", /older than the required 5\.0/);
  });

  it("distinguishes absent from too-old", () => {
    process.env.PATH = emptyDir("host-tools-empty-");
    const check = checkHostTool(requirement);
    assert.equal(check.ok, false);
    assert.match(check.problem ?? "", /not found on PATH/);
  });

  it("ignores a non-executable file of the right name", () => {
    // Reported as absent, not as "produced no version output": the latter sends
    // an operator looking at the tool instead of at its permissions.
    const dir = emptyDir("host-tools-noexec-");
    writeFileSync(join(dir, "faketool"), "#!/bin/sh\necho faketool 9.9\n");
    chmodSync(join(dir, "faketool"), 0o644);
    process.env.PATH = dir;
    const check = checkHostTool(requirement);
    assert.equal(check.ok, false);
    assert.match(check.problem ?? "", /not found on PATH/);
  });

  it("ignores a DIRECTORY of the right name", () => {
    const dir = emptyDir("host-tools-dir-");
    mkdirSync(join(dir, "faketool"), { mode: 0o755 });
    process.env.PATH = dir;
    assert.match(checkHostTool(requirement).problem ?? "", /not found on PATH/);
  });

  it("reads a version printed on stderr", () => {
    process.env.PATH = fakeTool("faketool", "faketool 6.1", "2");
    assert.equal(checkHostTool(requirement).ok, true);
  });

  it("fails when the tool prints nothing parseable", () => {
    process.env.PATH = fakeTool("faketool", "no numbers");
    const check = checkHostTool(requirement);
    assert.equal(check.ok, false);
    assert.match(check.problem ?? "", /could not be parsed/);
  });
});

describe("the committed table", () => {
  it("is readable and every entry is well formed", () => {
    const required = hostToolRequirements();
    assert.ok(required.length > 0, "expected at least one required host tool");
    for (const row of required) {
      assert.ok(row.binary.length > 0);
      assert.match(row.minVersion, /^\d+(\.\d+)*$/);
      assert.ok(row.versionArgs.length > 0);
      assert.ok(row.reason.length > 0);
    }
  });

  it("does not require git or ssh: the package wrapper vendors those", () => {
    const names = hostToolRequirements().map((row) => row.binary);
    assert.ok(!names.includes("git"));
    assert.ok(!names.includes("ssh"));
  });

  it.skipIf(!onLinux)("is satisfied by the machine running these tests", () => {
    const failures = checkHostTools().filter((check) => !check.ok);
    assert.deepEqual(
      failures.map((check) => `${check.requirement.binary}: ${check.problem}`),
      [],
    );
  });
});

describe("failure reporting", () => {
  it("names every failure at once", () => {
    const table = join(emptyDir("host-tools-table-"), "host-tools.json");
    writeFileSync(
      table,
      JSON.stringify({
        required: [
          {
            binary: "absent-one",
            minVersion: "1.0",
            versionArgs: ["--version"],
            reason: "first reason",
          },
          {
            binary: "absent-two",
            minVersion: "2.0",
            versionArgs: ["--version"],
            reason: "second reason",
          },
        ],
      }),
    );
    process.env.ASSISTANT_HOST_TOOLS = table;
    process.env.PATH = emptyDir("host-tools-empty-");
    resetHostToolsCache();
    const report = hostToolFailureReport() ?? "";
    assert.match(report, /absent-one/);
    assert.match(report, /absent-two/);
    assert.match(report, /first reason/);
    assert.match(report, /config\/host-tools\.json/);

    // Fatal in production, a warning elsewhere: the probes are GNU-shaped and a
    // developer's machine is not the deploy target. Passed explicitly because
    // NODE_ENV leaks into agent sessions from the production service.
    assert.throws(() => verifyRequiredHostTools({ fatal: true }), /absent-one/);
    verifyRequiredHostTools({ fatal: false });
  });

  it.skipIf(!onLinux)(
    "reports nothing when the real host satisfies the real table",
    () => {
      assert.equal(hostToolFailureReport(), undefined);
      verifyRequiredHostTools({ fatal: true });
    },
  );
});
