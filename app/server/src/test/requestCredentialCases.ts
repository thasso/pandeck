/**
 * The credential classifier's cases (Task-1430 C3), as data: the edge's
 * `gateway/requestCredential.ts` and the relay's own copy (PR2a; `relay/`
 * may not import `gateway/`) each run every case, so both classify alike.
 * Test-only; it imports nothing, so no runtime import widens. Every value is
 * fake.
 */

type CredentialClass = "none" | "placeholder" | "lease" | "other";

/** The public machine placeholder (`docs/workers.md` "Standalone harnesses"). */
export const PLACEHOLDER_FIXTURE =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoicGFuZGVjay1nYXRld2F5In0sInBhbmRlY2siOnsidiI6MSwibWFjaGluZSI6dHJ1ZX19.pandeck";

const segment = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Lease-shaped: three base64url segments whose payload names a lease. */
export const LEASE_FIXTURE = [
  segment({ alg: "none" }),
  segment({ pandeck: { v: 1, lease: "fixture-lease-1" } }),
  "Zml4dHVyZQ",
].join(".");

const P = `Bearer ${PLACEHOLDER_FIXTURE}`;
const L = `Bearer ${LEASE_FIXTURE}`;

/** Raw header pairs (as `IncomingMessage.rawHeaders`) and their class. */
export const CREDENTIAL_CASES: readonly {
  name: string;
  rawHeaders: string[];
  expected: CredentialClass;
}[] = [
  { name: "no header", rawHeaders: [], expected: "none" },
  {
    name: "no credential header",
    rawHeaders: ["content-type", "application/json"],
    expected: "none",
  },
  {
    name: "placeholder bearer",
    rawHeaders: ["authorization", P],
    expected: "placeholder",
  },
  {
    name: "placeholder api key",
    rawHeaders: ["x-api-key", PLACEHOLDER_FIXTURE],
    expected: "placeholder",
  },
  { name: "lease bearer", rawHeaders: ["authorization", L], expected: "lease" },
  {
    name: "lease api key",
    rawHeaders: ["x-api-key", LEASE_FIXTURE],
    expected: "lease",
  },
  ...[
    "Bearer sk-ant-something",
    `Basic ${Buffer.from("u:p").toString("base64")}`,
    "Bearer",
    "Bearer ",
    PLACEHOLDER_FIXTURE,
    `${P} extra`,
    "",
  ].map((value) => ({
    name: `other authorization ${JSON.stringify(value.slice(0, 20))}`,
    rawHeaders: ["authorization", value],
    expected: "other" as const,
  })),
  { name: "empty api key", rawHeaders: ["x-api-key", ""], expected: "other" },
  {
    name: "blank api key",
    rawHeaders: ["x-api-key", "   "],
    expected: "other",
  },
  {
    name: "proxy authorization",
    rawHeaders: ["proxy-authorization", "Basic abc"],
    expected: "other",
  },
  {
    name: "upper-case name, lower-case scheme",
    rawHeaders: ["AUTHORIZATION", `bearer ${LEASE_FIXTURE}`],
    expected: "lease",
  },
  {
    name: "mixed-case api key name",
    rawHeaders: ["X-Api-Key", PLACEHOLDER_FIXTURE],
    expected: "placeholder",
  },
  {
    name: "mixed-case proxy authorization",
    rawHeaders: ["Proxy-Authorization", "Basic abc"],
    expected: "other",
  },
  {
    name: "placeholder then lease",
    rawHeaders: ["authorization", P, "authorization", L],
    expected: "lease",
  },
  {
    name: "lease then placeholder",
    rawHeaders: ["authorization", L, "authorization", P],
    expected: "lease",
  },
  {
    name: "placeholder and a real api key",
    rawHeaders: ["authorization", P, "x-api-key", "sk-ant-api03-real"],
    expected: "other",
  },
  {
    name: "lease and an empty proxy authorization",
    rawHeaders: ["x-api-key", LEASE_FIXTURE, "proxy-authorization", ""],
    expected: "other",
  },
  {
    name: "placeholder api key and lease bearer",
    rawHeaders: ["x-api-key", PLACEHOLDER_FIXTURE, "Authorization", L],
    expected: "lease",
  },
  {
    name: "placeholder twice",
    rawHeaders: ["authorization", P, "x-api-key", PLACEHOLDER_FIXTURE],
    expected: "placeholder",
  },
];

/** Raw header pairs and whether they carry a client cookie. */
export const COOKIE_CASES: readonly {
  rawHeaders: string[];
  expected: boolean;
}[] = [
  { rawHeaders: [], expected: false },
  { rawHeaders: ["set-cookie", "a=b"], expected: false },
  { rawHeaders: ["cookie", ""], expected: true },
  { rawHeaders: ["Cookie", "a=b"], expected: true },
];
