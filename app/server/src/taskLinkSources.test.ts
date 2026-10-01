import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import { createTask, deleteTask } from "./tasks.ts";
import { updateForgejoSettings } from "./forgejoSettings.ts";

/**
 * Forgejo is self-hosted, so its links are classified against the CONFIGURED
 * instance rather than a fixed host — the one classification that depends on
 * settings, and therefore the one that can silently regress to `unknown`.
 */
function sourcesFor(urls: string[]): (string | undefined)[] {
  const created = createTask({
    title: "External link task",
    status: "todo",
    source: { createdBy: "user" },
    externalLinks: urls.map((url) => ({
      url,
      type: "source" as const,
      source: "unknown" as const,
    })),
  });
  try {
    return (created.externalLinks ?? []).map((link) => link.source);
  } finally {
    deleteTask(created.id);
  }
}

// Each test states the instance it assumes, so none depends on another's write.
beforeEach(() => {
  updateForgejoSettings({ enabled: false, baseUrl: "" });
});

test("external links classify the configured Forgejo instance", () => {
  updateForgejoSettings({ enabled: true, baseUrl: "https://git.example.test" });
  assert.deepEqual(
    sourcesFor([
      "https://git.example.test/acme/repo/pulls/7",
      "https://github.com/acme/repo/pull/7",
      "https://other.example.test/acme/repo/pulls/7",
    ]),
    ["forgejo", "github", "unknown"],
  );
});

test("no configured instance leaves a Forgejo-looking link unknown", () => {
  assert.deepEqual(sourcesFor(["https://git.example.test/acme/repo/pulls/7"]), [
    "unknown",
  ]);
});

test("the port distinguishes instances sharing a host", () => {
  updateForgejoSettings({ enabled: true, baseUrl: "http://localhost:3000" });
  assert.deepEqual(
    sourcesFor([
      "http://localhost:3000/acme/repo/pulls/7",
      "http://localhost:8080/some/other/service",
      "http://localhost/some/other/service",
    ]),
    ["forgejo", "unknown", "unknown"],
  );
});

test("an instance served under a path claims only that path", () => {
  updateForgejoSettings({
    enabled: true,
    baseUrl: "https://example.test/git",
  });
  assert.deepEqual(
    sourcesFor([
      "https://example.test/git/acme/repo/pulls/7",
      "https://example.test/wiki/page",
    ]),
    ["forgejo", "unknown"],
  );
});
