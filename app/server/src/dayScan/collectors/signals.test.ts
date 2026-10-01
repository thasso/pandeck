import assert from "node:assert/strict";
import { test } from "vitest";
import { sprintFact } from "./jiraSprints.ts";
import {
  ciFailureFact,
  deploymentFact,
  inWindowIso,
  releaseFact,
} from "./githubReleases.ts";

const OBSERVED = "2026-07-23T10:00:00.000Z";
const WINDOW = {
  startMs: Date.parse("2026-07-23T00:00:00Z"),
  endMs: Date.parse("2026-07-24T00:00:00Z"),
};

test("sprint fact carries the goal + board and is bounded (Task 142)", () => {
  const fact = sprintFact(
    {
      id: 42,
      name: "Sprint 7",
      state: "active",
      goal: "Ship DRM token binding",
      startDate: "2026-07-20",
      endDate: "2026-07-31",
    },
    { id: 3, name: "License Service", location: { projectKey: "WEB" } },
    OBSERVED,
  );
  assert.equal(fact.id, "jira-sprint:42");
  assert.equal(fact.kind, "sprint");
  assert.equal(fact.data?.goal, "Ship DRM token binding");
  assert.equal(fact.data?.boardName, "License Service");
  assert.equal(fact.data?.projectKey, "WEB");
  assert.deepEqual(fact.tags, ["sprint-goal", "attention"]);
});

test("release/deployment/ci facts have stable ids, github links, and attention tags", () => {
  const release = releaseFact(
    "acme/app",
    {
      id: 9,
      tag_name: "v1.2.0",
      published_at: "2026-07-23T09:00:00Z",
      html_url: "https://github.com/acme/app/releases/v1.2.0",
    },
    OBSERVED,
  );
  assert.equal(release.id, "ghr:acme/app:9");
  assert.equal(release.kind, "release");
  assert.match(release.links![0]!, /^https:\/\/github\.com\//);

  const deploy = deploymentFact(
    "acme/app",
    {
      id: 5,
      environment: "production",
      ref: "WEB-10 fix",
      created_at: "2026-07-23T09:30:00Z",
    },
    OBSERVED,
  );
  assert.equal(deploy.kind, "deployment");
  assert.equal(deploy.data?.environment, "production");

  const ci = ciFailureFact(
    "acme/app",
    {
      id: 7,
      name: "build",
      head_branch: "main",
      conclusion: "failure",
      created_at: "2026-07-23T08:00:00Z",
      html_url: "https://github.com/acme/app/actions/runs/7",
    },
    OBSERVED,
  );
  assert.equal(ci.kind, "ci-failure");
  assert.ok(ci.tags?.includes("attention"));
});

test("inWindowIso keeps only in-window timestamps", () => {
  assert.equal(inWindowIso("2026-07-23T09:00:00Z", WINDOW), true);
  assert.equal(inWindowIso("2026-07-22T23:59:00Z", WINDOW), false);
  assert.equal(inWindowIso("2026-07-24T00:00:00Z", WINDOW), false);
  assert.equal(inWindowIso(null, WINDOW), false);
});
