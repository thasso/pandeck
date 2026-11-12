/**
 * The gateway UI's config file (Task-1402): what refuses to start, that no
 * refusal echoes the file, and the allow rule.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  admittedEmail,
  GatewayWebConfigError,
  loadGatewayWebConfig,
  type AllowRule,
} from "./config.ts";

const PW = "config-test-client-pw";
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(change: (config: Record<string, unknown>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "gateway-web-config-"));
  directories.push(dir);
  const dist = join(dir, "dist");
  writeFileSync(join(dir, "cert.pem"), "CERT");
  writeFileSync(join(dir, "key.pem"), "KEY");
  mkdirSync(dist);
  writeFileSync(join(dist, "gateway.html"), "<!doctype html>");
  const config: Record<string, unknown> = {
    port: 8443,
    publicOrigin: "https://gateway.example.org",
    certFile: join(dir, "cert.pem"),
    keyFile: join(dir, "key.pem"),
    distDir: dist,
    oidc: {
      issuer: "https://issuer.example",
      clientId: "client",
      clientSecret: PW,
    },
    allow: {
      emailDomains: ["Example.org"],
      emails: [],
      claims: { hd: "example.org" },
    },
  };
  change(config);
  const file = join(dir, "ui.json");
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { dir, file };
}

function refusal(file: string): string {
  try {
    loadGatewayWebConfig(file);
  } catch (err) {
    assert.ok(err instanceof GatewayWebConfigError);
    assert.ok(!err.message.includes(PW), "the refusal holds no secret");
    return err.message;
  }
  assert.fail("the config was accepted");
}

test("a well-formed file loads, lowercasing the rule", () => {
  const { file, dir } = fixture();
  const config = loadGatewayWebConfig(file);
  assert.equal(config.port, 8443);
  assert.equal(config.publicOrigin, "https://gateway.example.org");
  assert.equal(config.certPem, "CERT");
  assert.equal(config.keyPem, "KEY");
  assert.equal(config.distDir, join(dir, "dist"));
  assert.deepEqual(config.oidc, {
    issuer: "https://issuer.example",
    clientId: "client",
    clientSecret: PW,
  });
  assert.deepEqual(config.allow, {
    emailDomains: ["example.org"],
    emails: [],
    claims: { hd: "example.org" },
  });
});

test("the port defaults to 443", () => {
  const { file } = fixture((c) => delete c.port);
  assert.equal(loadGatewayWebConfig(file).port, 443);
});

test("a file group or others can read refuses to start", () => {
  const { file } = fixture();
  chmodSync(file, 0o640);
  assert.match(refusal(file), /group or others/);
  chmodSync(file, 0o604);
  assert.match(refusal(file), /group or others/);
});

test("each unsafe or incomplete setting refuses with a fixed message", () => {
  const cases: [string, (c: Record<string, unknown>) => void, RegExp][] = [
    [
      "http origin",
      (c) => (c.publicOrigin = "http://gateway.example.org"),
      /publicOrigin/,
    ],
    [
      "origin with a path",
      (c) => (c.publicOrigin = "https://gateway.example.org/ui"),
      /publicOrigin/,
    ],
    [
      "origin with a slash",
      (c) => (c.publicOrigin = "https://gateway.example.org/"),
      /publicOrigin/,
    ],
    [
      "http issuer",
      (c) =>
        ((c.oidc as Record<string, unknown>).issuer = "http://issuer.example"),
      /oidc.issuer/,
    ],
    [
      "no client secret",
      (c) => delete (c.oidc as Record<string, unknown>).clientSecret,
      /oidc.clientSecret/,
    ],
    [
      "empty allow rule",
      (c) => (c.allow = { emailDomains: [], emails: [] }),
      /at least one/,
    ],
    ["no allow rule", (c) => delete c.allow, /allow/],
    [
      "claim not a string",
      (c) =>
        (c.allow = { emailDomains: ["example.org"], claims: { hd: true } }),
      /allow.claims/,
    ],
    ["missing cert", (c) => (c.certFile = "/nonexistent/cert.pem"), /certFile/],
    ["missing key", (c) => (c.keyFile = "/nonexistent/key.pem"), /keyFile/],
    ["no gateway.html", (c) => (c.distDir = "/nonexistent"), /gateway.html/],
    ["port out of range", (c) => (c.port = 70_000), /port/],
  ];
  for (const [name, change, expected] of cases)
    assert.match(refusal(fixture(change).file), expected, name);
});

test("a file that is not JSON refuses without echoing it", () => {
  const { file } = fixture();
  writeFileSync(file, `{"oidc": {"clientSecret": "${PW}"`, { mode: 0o600 });
  assert.match(refusal(file), /not valid JSON/);
});

test("the allow rule: a verified email by domain or address, and every claim", () => {
  const allow: AllowRule = {
    emailDomains: ["example.org"],
    emails: ["guest@example.net"],
    claims: { hd: "example.org" },
  };
  const ok = {
    email: "P@Example.org",
    email_verified: true,
    hd: "example.org",
  };
  assert.equal(admittedEmail(allow, ok), "p@example.org");
  assert.equal(
    admittedEmail(allow, { ...ok, email: "guest@example.net" }),
    "guest@example.net",
  );
  for (const claims of [
    { ...ok, email_verified: "true" },
    { ...ok, email_verified: 1 },
    { ...ok, email_verified: undefined },
    { ...ok, email: undefined },
    { ...ok, email: "" },
    { ...ok, email: "@example.org" },
    { ...ok, email: "p@sub.example.org" },
    { ...ok, email: "other@example.net" },
    { ...ok, hd: "example.net" },
    { ...ok, hd: undefined },
  ])
    assert.equal(
      admittedEmail(allow, claims),
      undefined,
      JSON.stringify(claims),
    );
});
