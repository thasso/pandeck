/**
 * The credential classifier on its own fixtures (Task-1430 C3, rv-1430-02
 * F04): never through a record, so the class rules are pinned apart from
 * what a record keeps.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { LeaseTable } from "./leases.ts";
import {
  classifyClientCredential,
  hasClientCookie,
  MACHINE_PLACEHOLDER,
} from "./requestCredential.ts";

const lease = new LeaseTable().grant(
  { profileId: "p1", provider: "claude", tokenFile: "/tmp/none" },
  { kind: "engine", owner: { workerId: "w1" } },
).token;

const raw = (...pairs: [string, string][]): string[] => pairs.flat();

test("no credential header is none; the placeholder is placeholder; a lease is lease", () => {
  assert.equal(classifyClientCredential([]), "none");
  assert.equal(
    classifyClientCredential(raw(["content-type", "application/json"])),
    "none",
  );
  assert.equal(
    classifyClientCredential(
      raw(["authorization", `Bearer ${MACHINE_PLACEHOLDER}`]),
    ),
    "placeholder",
  );
  assert.equal(
    classifyClientCredential(raw(["x-api-key", MACHINE_PLACEHOLDER])),
    "placeholder",
  );
  assert.equal(
    classifyClientCredential(raw(["authorization", `Bearer ${lease}`])),
    "lease",
  );
  assert.equal(classifyClientCredential(raw(["x-api-key", lease])), "lease");
});

test("anything else is other: another bearer, another scheme, malformed or empty", () => {
  for (const value of [
    "Bearer sk-ant-something",
    `Basic ${Buffer.from("u:p").toString("base64")}`,
    "Bearer",
    "Bearer ",
    MACHINE_PLACEHOLDER, // no scheme
    `Bearer ${MACHINE_PLACEHOLDER} extra`,
    "",
  ])
    assert.equal(
      classifyClientCredential(raw(["authorization", value])),
      "other",
      JSON.stringify(value),
    );
  assert.equal(classifyClientCredential(raw(["x-api-key", ""])), "other");
  assert.equal(classifyClientCredential(raw(["x-api-key", "   "])), "other");
  assert.equal(
    classifyClientCredential(raw(["proxy-authorization", "Basic abc"])),
    "other",
  );
});

test("header names count in any case", () => {
  assert.equal(
    classifyClientCredential(raw(["AUTHORIZATION", `bearer ${lease}`])),
    "lease",
  );
  assert.equal(
    classifyClientCredential(raw(["X-Api-Key", MACHINE_PLACEHOLDER])),
    "placeholder",
  );
  assert.equal(
    classifyClientCredential(raw(["Proxy-Authorization", "Basic abc"])),
    "other",
  );
});

test("every repeat counts and the most sensitive class wins", () => {
  const P = `Bearer ${MACHINE_PLACEHOLDER}`;
  const L = `Bearer ${lease}`;
  assert.equal(
    classifyClientCredential(raw(["authorization", P], ["authorization", L])),
    "lease",
  );
  assert.equal(
    classifyClientCredential(raw(["authorization", L], ["authorization", P])),
    "lease",
  );
  assert.equal(
    classifyClientCredential(
      raw(["authorization", P], ["x-api-key", "sk-ant-api03-real"]),
    ),
    "other",
  );
  assert.equal(
    classifyClientCredential(
      raw(["x-api-key", lease], ["proxy-authorization", ""]),
    ),
    "other",
  );
  assert.equal(
    classifyClientCredential(
      raw(["x-api-key", MACHINE_PLACEHOLDER], ["Authorization", L]),
    ),
    "lease",
  );
  assert.equal(
    classifyClientCredential(
      raw(["authorization", P], ["x-api-key", MACHINE_PLACEHOLDER]),
    ),
    "placeholder",
  );
});

test("a cookie is any cookie field, whatever its value", () => {
  assert.equal(hasClientCookie([]), false);
  assert.equal(hasClientCookie(raw(["set-cookie", "a=b"])), false);
  assert.equal(hasClientCookie(raw(["cookie", ""])), true);
  assert.equal(hasClientCookie(raw(["Cookie", "a=b"])), true);
});
