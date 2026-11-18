/**
 * The relay's interception CA and CONNECT decision (Task-1430 PR2b, ADR-0006):
 * the CA's DER fields read byte by byte (T1), chain verification under Node's
 * TLS with host-name checks off, so only the CA's name constraints can refuse
 * (T2), the files and their modes (T3), and every CONNECT target class (T4).
 */
import assert from "node:assert/strict";
import {
  createPrivateKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { afterAll, test } from "vitest";
import { connectTarget, type ConnectDecision } from "./connectTarget.ts";
import { loadInterceptCa, writeCaCertificate } from "./interceptCa.ts";

const root = mkdtempSync(join(tmpdir(), "relay-intercept-ca-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const freshDir = (): string => mkdtempSync(join(root, "s-"));

/** One DER element: tag, content bounds, and where the next one starts. */
interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function readTlv(der: Buffer, at: number): Tlv {
  const tag = der[at]!;
  let length = der[at + 1]!;
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i]!;
    start += count;
  }
  return { tag, start, end: start + length };
}

function children(der: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = parent.start; at < parent.end;) {
    const child = readTlv(der, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

function oidText(der: Buffer, element: Tlv): string {
  const bytes = der.subarray(element.start, element.end);
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

interface Extension {
  critical: boolean;
  /** The extension value's DER, inside its OCTET STRING. */
  value: Buffer;
}

/** The certificate's extensions by OID, read from the TBS `[3]` field. */
function extensionsOf(pem: string): Map<string, Extension> {
  const der = new X509Certificate(pem).raw;
  const tbs = children(der, readTlv(der, 0))[0]!;
  const wrapper = children(der, tbs).find((child) => child.tag === 0xa3)!;
  const list = children(der, wrapper)[0]!;
  const out = new Map<string, Extension>();
  for (const ext of children(der, list)) {
    const parts = children(der, ext);
    const critical =
      parts.length === 3 &&
      parts[1]!.tag === 0x01 &&
      der[parts[1]!.start] !== 0;
    const octets = parts[parts.length - 1]!;
    assert.equal(octets.tag, 0x04);
    out.set(oidText(der, parts[0]!), {
      critical,
      value: der.subarray(octets.start, octets.end),
    });
  }
  return out;
}

test("T1: the CA is EC P-256 with critical pathLen 0, key usage and name constraints (three DNS permitted, all IPv4 and IPv6 excluded)", () => {
  const ca = loadInterceptCa(freshDir());
  const cert = new X509Certificate(ca.certPem);
  assert.equal(cert.ca, true);
  assert.equal(cert.publicKey.asymmetricKeyType, "ec");
  assert.equal(cert.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.equal(cert.subject, "CN=Pandeck relay interception CA");
  const exts = extensionsOf(ca.certPem);

  const basic = exts.get("2.5.29.19")!;
  assert.equal(basic.critical, true);
  // SEQUENCE { BOOLEAN TRUE, INTEGER 0 }
  assert.equal(basic.value.toString("hex"), "30060101ff020100");

  const usage = exts.get("2.5.29.15")!;
  assert.equal(usage.critical, true);
  // BIT STRING, 1 unused bit, keyCertSign | cRLSign.
  assert.equal(usage.value.toString("hex"), "03020106");

  const constraints = exts.get("2.5.29.30")!;
  assert.equal(constraints.critical, true);
  const der = constraints.value;
  const top = children(der, readTlv(der, 0));
  assert.deepEqual(
    top.map((part) => part.tag),
    [0xa0, 0xa1],
    "IMPLICIT [0] permitted and [1] excluded, constructed",
  );
  const permitted = children(der, top[0]!).map((subtree) => {
    assert.equal(subtree.tag, 0x30);
    const [base, ...rest] = children(der, subtree);
    assert.equal(rest.length, 0, "no minimum or maximum");
    assert.equal(base!.tag, 0x82, "dNSName");
    return der.subarray(base!.start, base!.end).toString("ascii");
  });
  assert.deepEqual(permitted, ["anthropic.com", "claude.ai", "claude.com"]);
  const excluded = children(der, top[1]!).map((subtree) => {
    assert.equal(subtree.tag, 0x30);
    const [base, ...rest] = children(der, subtree);
    assert.equal(rest.length, 0);
    assert.equal(base!.tag, 0x87, "iPAddress");
    return der.subarray(base!.start, base!.end).toString("hex");
  });
  assert.deepEqual(excluded, ["00".repeat(8), "00".repeat(32)]);

  // Subject key identifier on the CA, the same id as each leaf's authority
  // key identifier.
  const skid = exts.get("2.5.29.14")!;
  assert.equal(skid.critical, false);
  const akid = extensionsOf(ca.leafFor("api.anthropic.com").cert).get(
    "2.5.29.35",
  )!;
  const skidBytes = skid.value.subarray(2).toString("hex");
  assert.equal(skidBytes.length, 40);
  assert.equal(akid.value.subarray(4).toString("hex"), skidBytes);
});

test("T1: a leaf names exactly its host, serves TLS only, lives 30 days, and comes as one key and certificate pair", () => {
  const ca = loadInterceptCa(freshDir());
  const leaf = ca.leafFor("api.anthropic.com");
  const cert = new X509Certificate(leaf.cert);
  assert.equal(cert.ca, false);
  assert.equal(cert.subjectAltName, "DNS:api.anthropic.com");
  assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
  assert.equal(cert.checkPrivateKey(createPrivateKey(leaf.key)), true);
  const days = (Date.parse(cert.validTo) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `valid for ${days} days`);
  assert.equal(cert.verify(new X509Certificate(ca.certPem).publicKey), true);
  assert.equal(ca.leafFor("api.anthropic.com").cert, leaf.cert, "cached");
  assert.equal(
    new X509Certificate(ca.leafFor("127.0.0.1").cert).subjectAltName,
    "IP Address:127.0.0.1",
  );
});

/**
 * Serves `leafFor(name)` and connects with the CA as the only trust root and
 * host-name checking off: the outcome is the chain's alone. Resolves the
 * client's verification error text (OpenSSL's; Node's code for both
 * name-constraint failures is the unhelpful `UNSPECIFIED`), or `"ok"`.
 */
async function verifyLeaf(
  ca: ReturnType<typeof loadInterceptCa>,
  name: string,
): Promise<string> {
  const leaf = ca.leafFor(name);
  const server = tls.createServer({ key: leaf.key, cert: leaf.cert }, (s) =>
    s.end(),
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    return await new Promise<string>((resolve) => {
      const socket = tls.connect({
        host: "127.0.0.1",
        port,
        ca: [ca.certPem],
        ...(net.isIP(name) ? {} : { servername: name }),
        checkServerIdentity: () => undefined,
      });
      socket.once("secureConnect", () => {
        resolve(socket.authorized ? "ok" : String(socket.authorizationError));
        socket.destroy();
      });
      socket.once("error", (err) => {
        resolve(err.message);
        socket.destroy();
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("T2: Node verifies leaves for the named domains and refuses other DNS names and an IP address by the CA's name constraints", async () => {
  const ca = loadInterceptCa(freshDir());
  for (const name of [
    "api.anthropic.com",
    "mcp-proxy.anthropic.com",
    "www.anthropic.com",
    "claude.ai",
  ])
    assert.equal(await verifyLeaf(ca, name), "ok", name);
  for (const name of [
    "example.com",
    "anthropic.com.evil.test",
    "evilanthropic.com",
  ])
    assert.equal(
      await verifyLeaf(ca, name),
      "permitted subtree violation",
      name,
    );
  // Only the excluded iPAddress subtree refuses this one: the DNS-only
  // permitted list does not constrain an IP name.
  assert.equal(await verifyLeaf(ca, "127.0.0.1"), "excluded subtree violation");
});

test("T3: the key stays 0600 in the state directory; the flag file is the certificate alone, 0644; a restart reuses the key", () => {
  const dir = freshDir();
  const ca = loadInterceptCa(dir);
  const keyPath = join(dir, "intercept-ca-key.pem");
  const storedPath = join(dir, "intercept-ca-cert.pem");
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(storedPath).mode & 0o777, 0o600);
  assert.match(readFileSync(keyPath, "utf8"), /PRIVATE KEY/);

  const outDir = mkdtempSync(join(root, "out-"));
  const flagPath = join(outDir, "ca.pem");
  writeCaCertificate(ca, flagPath);
  assert.equal(statSync(flagPath).mode & 0o777, 0o644);
  const written = readFileSync(flagPath, "utf8");
  assert.equal(written, ca.certPem);
  assert.doesNotMatch(written, /PRIVATE KEY/);
  assert.deepEqual(readdirSync(outDir), ["ca.pem"], "no temporary file left");
  // Over an existing file, still atomic and 0644.
  writeFileSync(flagPath, "old", { mode: 0o600 });
  writeCaCertificate(ca, flagPath);
  assert.equal(readFileSync(flagPath, "utf8"), ca.certPem);
  assert.equal(statSync(flagPath).mode & 0o777, 0o644);

  const key = readFileSync(keyPath, "utf8");
  const again = loadInterceptCa(dir);
  assert.equal(again.certPem, ca.certPem, "the stored certificate is kept");
  assert.equal(readFileSync(keyPath, "utf8"), key);

  rmSync(storedPath);
  const reissued = loadInterceptCa(dir);
  assert.notEqual(reissued.certPem, ca.certPem);
  assert.equal(readFileSync(keyPath, "utf8"), key, "the same key");
  assert.equal(
    new X509Certificate(reissued.certPem).checkPrivateKey(
      createPrivateKey(key),
    ),
    true,
  );
  assert.equal(readFileSync(storedPath, "utf8"), reissued.certPem);

  writeFileSync(storedPath, "not a certificate", { mode: 0o600 });
  assert.notEqual(loadInterceptCa(dir).certPem, "not a certificate");
});

test("T3: an unusable key throws a fixed message naming the file, never its content", () => {
  const dir = freshDir();
  const keyPath = join(dir, "intercept-ca-key.pem");
  writeFileSync(keyPath, "SECRET-NOT-A-KEY", { mode: 0o600 });
  assert.throws(
    () => loadInterceptCa(dir),
    (err: Error) =>
      err.message ===
        `${keyPath} is not an EC P-256 private key; delete intercept-ca-* in the relay's state directory and restart.` &&
      !err.message.includes("SECRET"),
  );
  // A real private key of another kind is refused the same way.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(
    keyPath,
    rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  );
  assert.throws(() => loadInterceptCa(dir), /is not an EC P-256 private key/);
});

const T4: [
  string[],
  ConnectDecision | ((target: string) => ConnectDecision),
][] = [
  [
    ["api.anthropic.com:443", "API.Anthropic.COM:443"],
    { kind: "intercept", host: "api.anthropic.com", route: "/anthropic" },
  ],
  [
    ["mcp-proxy.anthropic.com:443"],
    {
      kind: "intercept",
      host: "mcp-proxy.anthropic.com",
      route: "/anthropic-mcp",
    },
  ],
  [
    [
      "claude.ai:443",
      "anthropic.com:443",
      "www.claude.com:443",
      "downloads.claude.ai:443",
    ],
    (target) => ({
      kind: "tunnel",
      host: target.slice(0, -4),
      port: 443,
    }),
  ],
  [
    [
      "api.anthropic.com:8443",
      "api.anthropic.com:0",
      "api.anthropic.com:70000",
    ],
    { kind: "refuse", reason: "connect-port", host: "api.anthropic.com" },
  ],
  [
    ["claude.ai:80"],
    { kind: "refuse", reason: "connect-port", host: "claude.ai" },
  ],
  [
    ["api.anthropic.com.:443", "API.ANTHROPIC.COM.:8443"],
    { kind: "refuse", reason: "connect-target", host: "api.anthropic.com" },
  ],
  [
    ["claude.ai.:443"],
    { kind: "refuse", reason: "connect-target", host: "claude.ai" },
  ],
  [
    [
      "anthropic.com.evil.test:443",
      "evilanthropic.com:443",
      "example.com:443",
      "example.com.:443",
      "example.com:65535",
      "10.0.0.1:443",
      "127.0.0.1:65535",
    ],
    (target) => {
      const at = target.lastIndexOf(":");
      return {
        kind: "tunnel",
        host: target.slice(0, at),
        port: Number(target.slice(at + 1)),
      };
    },
  ],
  [["[::1]:443"], { kind: "tunnel", host: "::1", port: 443 }],
  [["[::1]:65535"], { kind: "tunnel", host: "::1", port: 65535 }],
  [
    ["[::ffff:1.2.3.4]:443"],
    { kind: "tunnel", host: "::ffff:1.2.3.4", port: 443 },
  ],
  [
    [
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "127.0.0.1:99999",
      "[::1]:0",
      "[::1]:65536",
      "[::1]:99999",
      "[api.anthropic.com]:443",
      "[1.2.3.4]:443",
      "[]:443",
      "api.anthropic.com?q=SENTINEL.anthropic.com:8443",
      "user@api.anthropic.com:443",
      "api.anthropic.com/x:443",
      "api.anthropic.com#f:443",
      "api.anthropic.com%2e:443",
      "api..anthropic.com:443",
      "-api.anthropic.com:443",
      "api.anthropic.com..:443",
      "api.anthropic.com",
      "api.anthropic.com:abc",
      ":443",
      "foo:",
      "example.com:0",
      "example.com:70000",
      "api.anthropic.com :443",
      "",
      `${"a".repeat(64)}.anthropic.com:443`,
    ],
    { kind: "malformed" },
  ],
];

test("T4: each CONNECT target class gets its decision; every tunnel's port is an integer in 1-65535", () => {
  for (const [targets, expected] of T4)
    for (const target of targets) {
      const decision = connectTarget(target);
      assert.deepEqual(
        decision,
        typeof expected === "function" ? expected(target) : expected,
        target,
      );
      if (decision.kind === "tunnel")
        assert.ok(
          Number.isInteger(decision.port) &&
            decision.port >= 1 &&
            decision.port <= 65535,
          target,
        );
    }
});
