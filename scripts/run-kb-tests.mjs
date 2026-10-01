#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = new Set(process.argv.slice(2));
if (targets.size === 0) targets.add("all");
if (targets.has("all")) {
  targets.add("server");
  targets.add("web");
}

const valid = new Set(["all", "server", "web"]);
for (const target of targets) {
  if (!valid.has(target)) {
    console.error(
      `Unknown target: ${target}. Expected one of: server, web, all.`,
    );
    process.exit(2);
  }
}

function walkFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const abs = join(dir, name);
      const stat = statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else out.push(abs);
    }
  };
  walk(root);
  return out;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function kbNamedTests(packageDir) {
  const src = join(packageDir, "src");
  const testName = /^knowledge.*\.test\.(ts|tsx)$/i;
  return walkFiles(src)
    .filter((file) => testName.test(file.split("/").pop() ?? ""))
    .map((file) => relative(packageDir, file));
}

function runVitest(packageDir, files) {
  const selected = uniqueSorted(files).filter((file) =>
    existsSync(join(packageDir, file)),
  );
  if (selected.length === 0) {
    console.error(`No KB test files found under ${packageDir}.`);
    return 1;
  }
  console.log(
    `Running ${selected.length} KB test file(s) in ${relative(repoRoot, packageDir)}:`,
  );
  for (const file of selected) console.log(`- ${file}`);
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...selected], {
    cwd: packageDir,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

let status = 0;
if (targets.has("server")) {
  status ||= runVitest(
    join(repoRoot, "app/server"),
    kbNamedTests(join(repoRoot, "app/server")),
  );
}
if (targets.has("web")) {
  const webDir = join(repoRoot, "app/web");
  status ||= runVitest(webDir, [
    ...kbNamedTests(webDir),
    "src/hooks/useSessionRouting.test.ts",
    "src/components/Markdown.test.tsx",
    "src/components/objectInspectors.test.ts",
  ]);
}
process.exit(status);
