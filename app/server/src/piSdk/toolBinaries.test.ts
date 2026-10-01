import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { linkPiToolBinaries } from "./toolBinaries.ts";

const tmpDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tmpDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A directory of fake executables standing in for one host PATH entry. */
function hostDir(root: string, dir: string, names: string[]): string {
  const path = join(root, dir);
  mkdirSync(path, { recursive: true });
  for (const name of names) {
    writeFileSync(join(path, name), "#!/bin/sh\n");
    chmodSync(join(path, name), 0o755);
  }
  return path;
}

/** An agent dir plus a fake host PATH directory holding `names`. */
function fixture(names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "pi-tool-binaries-"));
  tmpDirs.push(root);
  const hostBin = hostDir(root, "host-bin", names);
  const agentDir = join(root, "agent");
  const binDir = join(agentDir, "bin");
  const lines: string[] = [];
  const hostResolve = (name: string) =>
    names.includes(name) ? join(hostBin, name) : undefined;
  const link = (resolve: (name: string) => string | undefined = hostResolve) =>
    linkPiToolBinaries({ binDir, resolve, log: (line) => lines.push(line) });
  /** The production resolver: the real PATH, set to `entries`. */
  const linkFromPath = (entries: string[]) => {
    process.env.PATH = entries.join(delimiter);
    linkPiToolBinaries({ binDir, log: (line) => lines.push(line) });
  };
  return { root, hostBin, agentDir, binDir, lines, link, linkFromPath };
}

describe("linkPiToolBinaries", () => {
  it("links the host binaries and is idempotent", () => {
    const f = fixture(["rg", "fd"]);
    f.link();
    assert.equal(readlinkSync(join(f.binDir, "rg")), join(f.hostBin, "rg"));
    assert.equal(readlinkSync(join(f.binDir, "fd")), join(f.hostBin, "fd"));
    assert.equal(f.lines.length, 2);

    f.link();
    assert.equal(f.lines.length, 2, "a second run changes and logs nothing");
    assert.deepEqual(readdirSync(f.binDir).sort(), ["fd", "rg"]);
  });

  it("accepts Debian's fdfind for fd", () => {
    const f = fixture(["rg", "fdfind"]);
    f.link();
    assert.equal(readlinkSync(join(f.binDir, "fd")), join(f.hostBin, "fdfind"));
  });

  it("logs a missing binary and creates nothing for it", () => {
    const f = fixture(["rg"]);
    f.link();
    assert.deepEqual(readdirSync(f.binDir), ["rg"]);
    assert.equal(f.lines.filter((l) => l.includes("not on PATH")).length, 1);
    assert.match(f.lines.join("\n"), /fd\/fdfind not on PATH/);
  });

  it("creates no bin dir when neither binary is on PATH", () => {
    const f = fixture([]);
    f.link();
    assert.throws(() => lstatSync(f.binDir));
    assert.equal(f.lines.length, 2);
  });

  it("leaves a broken link, even its own, and names the manual fix", () => {
    const f = fixture(["rg", "fd"]);
    f.link();
    // The host binary it linked is uninstalled; a newer one is on PATH.
    rmSync(join(f.hostBin, "rg"));
    const moved = hostDir(f.root, "new-host-bin", ["rg"]);
    f.lines.length = 0;
    f.link((name) => join(moved, name));
    const link = join(f.binDir, "rg");
    assert.equal(readlinkSync(link), join(f.hostBin, "rg"));
    assert.deepEqual(f.lines, [
      `[assistant] pi tools: ${link} is a broken symlink and is left alone; pi's grep tool will fork the server to probe PATH on every call. Run \`rm ${link}\` and the next start links the host binary.`,
    ]);
    // After the operator's rm, the next start links the new binary.
    rmSync(link);
    f.link((name) => join(moved, name));
    assert.equal(readlinkSync(link), join(moved, "rg"));
  });

  it("never re-points a working link when PATH moves", () => {
    const f = fixture(["rg", "fd"]);
    f.link();
    const moved = hostDir(f.root, "new-host-bin", ["rg", "fd"]);
    f.lines.length = 0;
    f.link((name) => join(moved, name));
    assert.equal(readlinkSync(join(f.binDir, "rg")), join(f.hostBin, "rg"));
    assert.deepEqual(f.lines, []);
  });

  it("never clobbers a real file or a working symlink", () => {
    const f = fixture(["rg", "fd"]);
    mkdirSync(f.binDir, { recursive: true });
    writeFileSync(join(f.binDir, "rg"), "downloaded by pi");
    const custom = join(f.root, "custom-fd");
    writeFileSync(custom, "#!/bin/sh\n");
    symlinkSync(custom, join(f.binDir, "fd"));
    f.link();
    assert.equal(
      readFileSync(join(f.binDir, "rg"), "utf8"),
      "downloaded by pi",
    );
    assert.equal(readlinkSync(join(f.binDir, "fd")), custom);
    assert.equal(f.lines.length, 0);
  });

  it("loses to a writer that lands between its check and its create", () => {
    const f = fixture(["rg", "fd"]);
    // The resolver runs after the existence check and before the symlink,
    // exactly where pi's download could finish.
    f.link((name) => {
      if (name === "rg") {
        mkdirSync(f.binDir, { recursive: true });
        writeFileSync(join(f.binDir, "rg"), "downloaded by pi");
      }
      return join(f.hostBin, name);
    });
    assert.equal(
      readFileSync(join(f.binDir, "rg"), "utf8"),
      "downloaded by pi",
    );
    assert.equal(readlinkSync(join(f.binDir, "fd")), join(f.hostBin, "fd"));
    assert.deepEqual(readdirSync(f.binDir).sort(), ["fd", "rg"]);
  });

  it("links an absolute target for a relative PATH entry", () => {
    const f = fixture(["rg", "fd"]);
    f.linkFromPath([relative(process.cwd(), f.hostBin)]);
    assert.equal(readlinkSync(join(f.binDir, "rg")), join(f.hostBin, "rg"));
    assert.ok(statSync(join(f.binDir, "rg")).isFile());
  });

  it("never targets pi's bin dir, directly or through an alias", () => {
    const f = fixture(["rg", "fdfind"]);
    hostDir(f.root, "agent/bin", ["fdfind"]);
    const alias = join(f.root, "bin-alias");
    symlinkSync(f.binDir, alias);
    f.linkFromPath([f.binDir, alias, f.hostBin]);
    assert.equal(readlinkSync(join(f.binDir, "fd")), join(f.hostBin, "fdfind"));
    assert.equal(readlinkSync(join(f.binDir, "rg")), join(f.hostBin, "rg"));
  });

  it("stops pi's tool lookup from spawning once linked", () => {
    const f = fixture(["rg", "fd"]);
    f.link();
    // pi freezes its bin dir when tools-manager loads, from PI_CODING_AGENT_DIR,
    // so the real module is measured in a fresh process pointed at the fixture.
    const toolsManager = join(
      dirname(
        fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
      ),
      "utils",
      "tools-manager.js",
    );
    const script = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      let spawns = 0;
      const spawnSync = childProcess.spawnSync;
      childProcess.spawnSync = (...args) => (spawns++, spawnSync(...args));
      syncBuiltinESMExports();
      const { getToolPath } = await import(${JSON.stringify(toolsManager)});
      const paths = [getToolPath("rg"), getToolPath("fd")];
      console.log(JSON.stringify({ spawns, paths }));
    `;
    const run = (agentDir: string) =>
      JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
          encoding: "utf8",
        }),
      ) as { spawns: number; paths: string[] };

    assert.deepEqual(run(f.agentDir), {
      spawns: 0,
      paths: [join(f.binDir, "rg"), join(f.binDir, "fd")],
    });
    // Control: without the links the same lookup probes PATH by spawning.
    assert.ok(run(join(f.root, "unlinked")).spawns >= 2);
  });
});
