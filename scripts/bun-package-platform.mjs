import { closeSync, openSync, readSync } from "node:fs";

/** Native builds only. Linux packages use glibc; Darwin starts with arm64. */
export function bunPackageTarget(
  platform = process.platform,
  arch = process.arch,
) {
  if (!(
    (platform === "linux" && ["x64", "arm64"].includes(arch)) ||
    (platform === "darwin" && arch === "arm64")
  ))
    throw new Error(`Unsupported Bun package target: ${platform}-${arch}.`);
  return {
    platform,
    arch,
    watcherPackage: `@parcel/watcher-${platform}-${arch}${platform === "linux" ? "-glibc" : ""}`,
    claudePackage: `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`,
  };
}

/** Refuse mixed-host assets before copying them into a runnable package. */
export function assertNativeBinary(path, target = bunPackageTarget()) {
  const header = Buffer.alloc(64);
  const descriptor = openSync(path, "r");
  let length;
  try {
    length = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const valid =
    length >= 20 &&
    (target.platform === "darwin"
      ? header.readUInt32LE(0) === 0xfeedfacf &&
        header.readUInt32LE(4) === 0x0100000c
      : header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
        header[4] === 2 &&
        header[5] === 1 &&
        header.readUInt16LE(18) === (target.arch === "x64" ? 62 : 183));
  if (!valid)
    throw new Error(
      `Expected a ${target.platform}-${target.arch} native binary: ${path}`,
    );
}
