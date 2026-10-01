import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import type { ProjectRecord } from "@assistant/shared";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import {
  correlateFacts,
  corroboratedIssueKeys,
  extractIssueKeys,
} from "./correlate.ts";
import {
  buildMappingIndex,
  classifyFact,
  MAPPING_OVERLAY_ASSET,
} from "./classify.ts";
import type { DaySourceFact } from "./types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fact(id: string, extra: Partial<DaySourceFact> = {}): DaySourceFact {
  return { id, kind: "item", observedAt: "2026-07-13T10:00:00.000Z", ...extra };
}

const projects: ProjectRecord[] = [
  {
    id: "web-player",
    name: "Web Player",
    key: "WEB",
    jira: [
      { projectKey: "WEB", role: "primary" },
      { projectKey: "QA", role: "historical" },
    ],
  },
  {
    id: "mtk",
    name: "Media Toolkit",
    key: "MTK",
    jira: [{ projectKey: "MTK" }],
    repoUrl: "https://github.com/acme/media-toolkit.git",
  },
];

test("extractIssueKeys finds Jira keys in refs and titles", () => {
  assert.deepEqual(extractIssueKeys("WEB-8487-fix-ssai and MOB-885"), [
    "WEB-8487",
    "MOB-885",
  ]);
  assert.deepEqual(extractIssueKeys("no keys here"), []);
});

test("correlation joins GitHub branch refs to Jira issues and resolves own identity", () => {
  const correlated = correlateFacts(
    [
      {
        source: "github-events",
        facts: [
          fact("gh:1", {
            actor: "alice",
            data: { repo: "acme/web-player", ref: "WEB-8487-fix" },
          }),
        ],
      },
      {
        source: "jira",
        facts: [fact("jira:WEB-8487", { data: { projectKey: "WEB" } })],
      },
    ],
    { githubLogin: "alice" },
  );
  const gh = correlated.find((c) => c.fact.id === "gh:1")!;
  assert.deepEqual(gh.issueKeys, ["WEB-8487"]);
  assert.deepEqual(gh.projectKeys, ["WEB"]);
  assert.equal(gh.own, true, "github actor matches the mapped identity");
  assert.deepEqual(
    [...corroboratedIssueKeys(correlated)],
    ["WEB-8487"],
    "issue seen in two sources is corroborated",
  );
});

test("classification precedence: override → registry primary jira → repoUrl → weak links → heuristic → unmapped", async () => {
  const kbRoot = mkdtempSync(join(tmpdir(), "day-scan-mapping-"));
  cleanups.push(() => rmSync(kbRoot, { recursive: true, force: true }));
  const store = new KnowledgeBaseStore(kbRoot);
  await store.commitChanges(
    [
      {
        op: "write",
        path: MAPPING_OVERLAY_ASSET,
        content: JSON.stringify({
          overrides: [
            {
              jiraProject: "NEB",
              bucket: "nebulamark",
              label: "NEBULAMark",
              secondary: ["watermarking"],
            },
          ],
        }),
      },
    ],
    { actor: { kind: "system", name: "test" }, reason: "mapping overlay" },
  );
  const index = await buildMappingIndex({ store, projects });

  const classify = (partial: {
    projectKeys?: string[];
    repo?: string | null;
  }) =>
    classifyFact(
      {
        source: "jira",
        fact: fact("x"),
        issueKeys: [],
        projectKeys: partial.projectKeys ?? [],
        repo: partial.repo ?? null,
        own: false,
      },
      index,
    );

  const override = classify({ projectKeys: ["NEB"] });
  assert.equal(override.source, "override");
  assert.equal(override.bucket, "nebulamark");
  assert.deepEqual(override.secondary, ["watermarking"]);

  const primary = classify({ projectKeys: ["WEB"] });
  assert.equal(primary.source, "registry-jira");
  assert.equal(primary.projectId, "web-player");
  assert.equal(primary.confidence, "high");

  const viaRepo = classify({ repo: "acme/media-toolkit" });
  assert.equal(viaRepo.source, "registry-git");
  assert.equal(viaRepo.projectId, "mtk", "repoUrl counts as mapping evidence");

  const weak = classify({ projectKeys: ["QA"] });
  assert.equal(weak.source, "registry-jira-weak");
  assert.equal(weak.confidence, "low", "historical links are weak hints");

  const heuristic = classify({ projectKeys: ["ZZZ"] });
  assert.equal(heuristic.source, "heuristic");
  assert.equal(heuristic.bucket, "jira:ZZZ");
  assert.equal(heuristic.projectId, null);

  const unmapped = classify({});
  assert.equal(unmapped.source, "unmapped");
  assert.equal(unmapped.bucket, "unmapped");

  assert.ok(
    index.version.length > 0,
    "mapping version is recorded for the manifest",
  );
});
