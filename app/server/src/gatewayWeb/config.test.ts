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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { FAKE_CLIENT } from "../test/atlassianFake.ts";
import {
  admittedEmail,
  defaultDistDir,
  GatewayWebConfigError,
  loadGatewayWebConfig,
  type AllowRule,
} from "./config.ts";

const PW = "config-test-client-pw";

/** The split plan's default list (Task-1411 PR2), written out, not imported. */
const DEFAULT_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "read:servicedesk-request",
  "write:servicedesk-request",
  "read:confluence-content.all",
  "write:confluence-content",
  "offline_access",
];
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

test("the Atlassian preset is optional and, when given, fixes the site and the sign-in email", () => {
  assert.equal(loadGatewayWebConfig(fixture().file).atlassian, undefined);
  const { file } = fixture(
    (c) =>
      (c.atlassian = { site: " team.atlassian.net ", emailFromSignIn: true }),
  );
  assert.deepEqual(loadGatewayWebConfig(file).atlassian, {
    site: "team.atlassian.net",
    emailFromSignIn: true,
    scopes: DEFAULT_SCOPES,
  });
  const siteOnly = fixture((c) => (c.atlassian = { site: "t.atlassian.net" }));
  assert.deepEqual(loadGatewayWebConfig(siteOnly.file).atlassian, {
    site: "t.atlassian.net",
    emailFromSignIn: false,
    scopes: DEFAULT_SCOPES,
  });
});

test("the Atlassian OAuth client: clientId and clientSecret each load alone or together; empty ones refuse without echoing", () => {
  const load = (atlassian: Record<string, unknown>) =>
    loadGatewayWebConfig(fixture((c) => (c.atlassian = atlassian)).file)
      .atlassian;
  assert.deepEqual(load({ clientId: FAKE_CLIENT.clientId }), {
    emailFromSignIn: false,
    clientId: FAKE_CLIENT.clientId,
    scopes: DEFAULT_SCOPES,
  });
  assert.deepEqual(load({ clientSecret: FAKE_CLIENT.clientSecret }), {
    emailFromSignIn: false,
    clientSecret: FAKE_CLIENT.clientSecret,
    scopes: DEFAULT_SCOPES,
  });
  assert.deepEqual(
    load({
      site: "t.atlassian.net",
      clientId: FAKE_CLIENT.clientId,
      clientSecret: FAKE_CLIENT.clientSecret,
    }),
    {
      site: "t.atlassian.net",
      emailFromSignIn: false,
      clientId: FAKE_CLIENT.clientId,
      clientSecret: FAKE_CLIENT.clientSecret,
      scopes: DEFAULT_SCOPES,
    },
  );
  for (const [atlassian, field] of [
    [
      { clientId: "", clientSecret: FAKE_CLIENT.clientSecret },
      /atlassian\.clientId/,
    ],
    [
      { clientId: " ", clientSecret: FAKE_CLIENT.clientSecret },
      /atlassian\.clientId/,
    ],
    [
      { clientId: FAKE_CLIENT.clientId, clientSecret: "" },
      /atlassian\.clientSecret/,
    ],
    [
      { clientId: FAKE_CLIENT.clientId, clientSecret: 7 },
      /atlassian\.clientSecret/,
    ],
  ] as const) {
    const message = refusal(fixture((c) => (c.atlassian = atlassian)).file);
    assert.match(message, field);
    assert.doesNotMatch(
      message,
      new RegExp(`${FAKE_CLIENT.clientId}|${FAKE_CLIENT.clientSecret}`),
    );
  }
});

test("atlassian.scopes: absent gives the default list; a list keeps case, drops duplicates and always ends with offline_access", () => {
  const scopes = (value: unknown) =>
    loadGatewayWebConfig(
      fixture(
        (c) =>
          (c.atlassian = {
            clientId: FAKE_CLIENT.clientId,
            ...(value === undefined ? {} : { scopes: value }),
          }),
      ).file,
    ).atlassian?.scopes;
  assert.deepEqual(scopes(undefined), DEFAULT_SCOPES);
  assert.deepEqual(scopes(["read:jira-work"]), [
    "read:jira-work",
    "offline_access",
  ]);
  assert.deepEqual(scopes(["Read:Jira-Work"]), [
    "Read:Jira-Work",
    "offline_access",
  ]);
  assert.deepEqual(
    scopes(["offline_access", "read:jira-work", "read:jira-work"]),
    ["offline_access", "read:jira-work"],
  );
  assert.equal(
    scopes(Array.from({ length: 64 }, (_, i) => `s${i}`))?.length,
    65,
  );
});

test("atlassian.scopes refuses a non-list, an empty or spaced entry, a long entry and more than 64 entries, naming only the field", () => {
  const SENTINEL = "FAKE_SCOPE_SENTINEL";
  for (const value of [
    SENTINEL,
    [SENTINEL, ""],
    [SENTINEL, `${SENTINEL} x`],
    [SENTINEL, 7],
    [`${SENTINEL}\u00e9`],
    [`${SENTINEL}${"x".repeat(128)}`],
    Array.from({ length: 65 }, (_, i) => `${SENTINEL}${i}`),
  ]) {
    const message = refusal(
      fixture((c) => (c.atlassian = { scopes: value })).file,
    );
    assert.match(message, /^gateway UI config: atlassian\.scopes /);
    assert.doesNotMatch(message, new RegExp(SENTINEL));
  }
});

/** Synthetic: Coder's Google client id and a v02-style Coder token. */
const FAKE_CODER_CLIENT_ID = "FAKE_coder-google-client.apps.example";
const FAKE_CODER_API_TOKEN = "FAKE_coder-api-token-sentinel";
const GOOGLE = "https://accounts.google.com";

/** The fixture with Google as its issuer and `coder` as given. */
function coderFixture(coder: unknown, issuer = GOOGLE) {
  return fixture((c) => {
    (c.oidc as Record<string, unknown>).issuer = issuer;
    c.coder = coder;
  });
}

test("the coder preset: absent leaves coder undefined; given, both keys load", () => {
  assert.equal(loadGatewayWebConfig(fixture().file).coder, undefined);
  assert.deepEqual(
    loadGatewayWebConfig(
      coderFixture({
        googleClientId: ` ${FAKE_CODER_CLIENT_ID} `,
        automaticApproval: true,
      }).file,
    ).coder,
    { googleClientId: FAKE_CODER_CLIENT_ID, automaticApproval: true },
  );
  // Turned off, the client id stays.
  assert.deepEqual(
    loadGatewayWebConfig(
      coderFixture({
        googleClientId: FAKE_CODER_CLIENT_ID,
        automaticApproval: false,
      }).file,
    ).coder,
    { googleClientId: FAKE_CODER_CLIENT_ID, automaticApproval: false },
  );
});

test("the coder preset refuses a missing or empty id, a non-boolean switch, an unknown key and a non-Google issuer, naming the field and no value", () => {
  const valid = {
    googleClientId: FAKE_CODER_CLIENT_ID,
    automaticApproval: true,
  };
  const cases: [string, unknown, string | undefined, RegExp][] = [
    ["not an object", "x", undefined, /^gateway UI config: coder must be/],
    ["a list", [valid], undefined, /^gateway UI config: coder must be/],
    [
      "missing id",
      { automaticApproval: true },
      undefined,
      /^gateway UI config: coder\.googleClientId /,
    ],
    [
      "empty id",
      { ...valid, googleClientId: " " },
      undefined,
      /^gateway UI config: coder\.googleClientId /,
    ],
    [
      "id not a string",
      { ...valid, googleClientId: 7 },
      undefined,
      /^gateway UI config: coder\.googleClientId /,
    ],
    [
      "missing switch",
      { googleClientId: FAKE_CODER_CLIENT_ID },
      undefined,
      /^gateway UI config: coder\.automaticApproval /,
    ],
    [
      "switch a string",
      { ...valid, automaticApproval: "true" },
      undefined,
      /^gateway UI config: coder\.automaticApproval /,
    ],
    [
      "an apiToken",
      { ...valid, apiToken: FAKE_CODER_API_TOKEN },
      undefined,
      /^gateway UI config: coder takes only /,
    ],
    [
      "another issuer",
      valid,
      "https://issuer.example",
      /^gateway UI config: coder needs oidc\.issuer https:\/\/accounts\.google\.com$/,
    ],
    [
      "Google's issuer with a slash",
      valid,
      "https://accounts.google.com/",
      /^gateway UI config: coder needs oidc\.issuer /,
    ],
  ];
  for (const [name, coder, issuer, expected] of cases) {
    const message = refusal(coderFixture(coder, issuer).file);
    assert.match(message, expected, name);
    assert.ok(!message.includes(FAKE_CODER_CLIENT_ID), `${name}: no id`);
    assert.ok(!message.includes(FAKE_CODER_API_TOKEN), `${name}: no token`);
    assert.ok(!message.includes("apiToken"), `${name}: no key from the file`);
  }
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
    ["atlassian not an object", (c) => (c.atlassian = "x"), /atlassian/],
    [
      "empty atlassian site",
      (c) => (c.atlassian = { site: " " }),
      /atlassian.site/,
    ],
    [
      "emailFromSignIn not a boolean",
      (c) => (c.atlassian = { emailFromSignIn: "yes" }),
      /atlassian.emailFromSignIn/,
    ],
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

test("without distDir, the source reads the checkout's build and a bundle the directory beside it", () => {
  const checkout = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../web/dist-gateway",
  );
  assert.equal(defaultDistDir(), checkout);
  assert.equal(
    defaultDistDir("file:///opt/pandeck/runtime/gateway-edge.js"),
    "/opt/pandeck/runtime/gateway-web",
  );
  // The default is checked like a named directory.
  const { file } = fixture((config) => delete config.distDir);
  try {
    assert.equal(loadGatewayWebConfig(file).distDir, checkout);
  } catch (err) {
    assert.ok(err instanceof GatewayWebConfigError);
    assert.match(err.message, /distDir holds no gateway\.html/);
  }
});
