import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import {
  isStoryPreviewId,
  storyCatalog,
  type StoryPreviewId,
} from "./storyCatalog.ts";

const previewRoot = import.meta.dirname;
const webRoot = resolve(previewRoot, "..");
const outputRoot = resolve(previewRoot, "dist");

function usage(): never {
  const ids = Object.keys(storyCatalog)
    .map((id) => `  ${id}`)
    .join("\n");
  throw new Error(`Usage: pnpm preview:story <story-id>\n\nStories:\n${ids}`);
}

function sourceRevision(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: webRoot,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      { cwd: webRoot, encoding: "utf8" },
    ).trim();
    return dirty ? `${head} + working tree` : head;
  } catch {
    return "working tree";
  }
}

async function filesBelow(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(
        ...(await filesBelow(resolve(directory, entry.name), relative)),
      );
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function contentHash(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const relative of await filesBelow(directory)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(await readFile(resolve(directory, relative)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function directFileUrl(path: string): string {
  return `/api/files/${path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")}`;
}

function markdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
}

async function buildStory(storyId: StoryPreviewId): Promise<void> {
  await mkdir(outputRoot, { recursive: true });
  const temporary = resolve(
    outputRoot,
    `.build-${process.pid}-${Date.now().toString(36)}`,
  );
  process.env.PA_PREVIEW_STORY = storyId;
  process.env.PA_PREVIEW_OUT_DIR = temporary;
  process.env.PA_PREVIEW_REVISION = sourceRevision();

  try {
    await build({
      configFile: resolve(previewRoot, "vite.config.ts"),
      mode: "production",
    });
    const generation = await contentHash(temporary);
    const finalDirectory = resolve(outputRoot, generation);
    try {
      await rename(temporary, finalDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await rm(temporary, { recursive: true, force: true });
    }
    const documentPath = resolve(finalDirectory, "index.html");
    const definition = storyCatalog[storyId];
    const markdown = `![${markdownLabel(definition.title)}](${directFileUrl(documentPath)})`;
    console.log(`\nStory preview: ${documentPath}`);
    console.log(`Chat embed: ${markdown}`);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

const storyId =
  process.argv.slice(2).find((argument) => argument !== "--") ?? "";
if (!isStoryPreviewId(storyId)) usage();
await buildStory(storyId);
