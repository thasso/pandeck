import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertNativeBinary,
  bunPackageTarget,
} from "./bun-package-platform.mjs";

test("native targets select the locked watcher and Claude packages", () => {
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
  ]) {
    const target = bunPackageTarget(platform, arch);
    assert.equal(target.platform, platform);
    assert.equal(target.arch, arch);
    assert.equal(
      target.watcherPackage,
      `@parcel/watcher-${platform}-${arch}${platform === "linux" ? "-glibc" : ""}`,
    );
    assert.equal(
      target.claudePackage,
      `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
    );
  }
  for (const [platform, arch] of [
    ["darwin", "x64"],
    ["win32", "arm64"],
    ["linux", "ia32"],
  ])
    assert.throws(() => bunPackageTarget(platform, arch), /Unsupported/);
});

function elf(machine) {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  header.writeUInt16LE(machine, 18);
  return header;
}

function macho(cpu) {
  const header = Buffer.alloc(64);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  return header;
}

test("native validation rejects wrong OS, CPU, scripts and truncated inputs", () => {
  const temp = mkdtempSync(join(tmpdir(), "bun-package-platform-"));
  const path = join(temp, "native");
  try {
    for (const [platform, arch, header] of [
      ["linux", "x64", elf(62)],
      ["linux", "arm64", elf(183)],
      ["darwin", "arm64", macho(0x0100000c)],
    ]) {
      const target = bunPackageTarget(platform, arch);
      writeFileSync(path, header);
      assert.doesNotThrow(() => assertNativeBinary(path, target));
      for (const bad of [
        elf(3),
        macho(0x01000007),
        Buffer.from("#!/bin/sh\n"),
        header.subarray(0, 8),
        platform === "linux" ? macho(0x0100000c) : elf(183),
        platform === "linux" ? elf(arch === "x64" ? 183 : 62) : elf(62),
      ]) {
        writeFileSync(path, bad);
        assert.throws(() => assertNativeBinary(path, target), /Expected a/);
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
