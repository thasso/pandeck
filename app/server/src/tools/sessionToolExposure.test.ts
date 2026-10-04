/**
 * The engine-neutral tool-exposure registry the Tools inspector reads.
 *   pnpm --filter @assistant/server test src/tools/sessionToolExposure.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { SessionToolExposure } from "@assistant/shared";
import {
  registerSessionToolExposure,
  sessionToolExposure,
} from "./sessionToolExposure.ts";

const exposure = (label: string) =>
  ({ label }) as unknown as SessionToolExposure;

test("a session's exposure is read through whichever engine registered it", () => {
  assert.equal(sessionToolExposure("unregistered"), undefined);
  const unregister = registerSessionToolExposure("s1", () => exposure("live"));
  assert.deepEqual(sessionToolExposure("s1"), exposure("live"));
  unregister();
  assert.equal(sessionToolExposure("s1"), undefined);
});

test("an older registration's teardown never removes its replacement", () => {
  const first = registerSessionToolExposure("s2", () => exposure("first"));
  registerSessionToolExposure("s2", () => exposure("second"));
  first();
  assert.deepEqual(sessionToolExposure("s2"), exposure("second"));
});
