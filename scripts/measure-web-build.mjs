#!/usr/bin/env node
import { gzipSync } from "node:zlib";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const distDir = new URL("../app/web/dist/", import.meta.url);
const distPath = distDir.pathname;
const assetDir = join(distPath, "assets");

if (!existsSync(distPath) || !existsSync(assetDir)) {
  console.error("app/web/dist is missing. Run `pnpm run build` first.");
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function sizeInfo(path) {
  const raw = readFileSync(path);
  return {
    path,
    relativePath: relative(distPath, path),
    bytes: statSync(path).size,
    gzipBytes: gzipSync(raw).length,
  };
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function sum(items, key) {
  return items.reduce((total, item) => total + item[key], 0);
}

function cachePolicyFor(relativePath) {
  if (relativePath === "index.html") return "no-cache";
  if (relativePath.startsWith("assets/")) return "1y immutable";
  if (/\.(webmanifest|svg|png|ico|css)$/.test(relativePath))
    return "5m + stale-while-revalidate";
  return "5m + stale-while-revalidate";
}

const files = walk(distPath)
  .map(sizeInfo)
  .sort((a, b) => b.bytes - a.bytes);
const js = files.filter((file) => extname(file.path) === ".js");
const css = files.filter((file) => extname(file.path) === ".css");
const html = files.filter((file) => extname(file.path) === ".html");
const publicAssets = files.filter(
  (file) =>
    !file.relativePath.startsWith("assets/") &&
    file.relativePath !== "index.html",
);

console.log("Web production build measurement");
console.log("================================");
console.log(`Total files:      ${files.length}`);
console.log(`Total raw:        ${formatBytes(sum(files, "bytes"))}`);
console.log(`Total gzip:       ${formatBytes(sum(files, "gzipBytes"))}`);
console.log(
  `JS raw / gzip:    ${formatBytes(sum(js, "bytes"))} / ${formatBytes(sum(js, "gzipBytes"))} across ${js.length} chunks`,
);
console.log(
  `CSS raw / gzip:   ${formatBytes(sum(css, "bytes"))} / ${formatBytes(sum(css, "gzipBytes"))} across ${css.length} files`,
);
console.log(
  `HTML raw / gzip:  ${formatBytes(sum(html, "bytes"))} / ${formatBytes(sum(html, "gzipBytes"))}`,
);
console.log("");

console.log("Largest JS chunks");
console.log("-----------------");
for (const file of js.slice(0, 10)) {
  console.log(
    `${formatBytes(file.bytes).padStart(10)} raw  ${formatBytes(file.gzipBytes).padStart(10)} gzip  ${file.relativePath}`,
  );
}
console.log("");

console.log("Production cache policy check");
console.log("-----------------------------");
const cacheSamples = [
  ...html,
  ...files
    .filter((file) => file.relativePath.startsWith("assets/"))
    .slice(0, 5),
  ...publicAssets.slice(0, 8),
];
for (const file of cacheSamples) {
  console.log(
    `${cachePolicyFor(file.relativePath).padEnd(30)} ${file.relativePath}`,
  );
}
