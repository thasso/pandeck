/**
 * The relay's interception CA (Task-1430, ADR-0006): the certificate authority
 * a `claude-gateway` process trusts through `NODE_EXTRA_CA_CERTS`, never a
 * system or browser store, and the leaves the relay presents for the token
 * hosts it decrypts.
 *
 * - The CA is EC P-256 with critical basic constraints (CA, path length 0),
 *   critical key usage (keyCertSign, cRLSign) and critical name constraints:
 *   permitted DNS names are the named domains (`connectTarget.ts`), and every
 *   IPv4 and IPv6 address is excluded. A leaf for any other name fails chain
 *   verification, whoever holds the key.
 * - The key is `intercept-ca-key.pem` (0600) in the relay's state directory
 *   and never leaves it. The CA certificate is kept beside it (0600) and
 *   written, certificate only, to the path the operator names (0644, atomic).
 *   The key is reused across restarts; its certificate is reissued from the
 *   same key when missing, unreadable, for another key, for another set of
 *   constraints, or within 30 days of expiry.
 * - A leaf names exactly one host, is valid for 30 days and lives only in
 *   memory; its key and certificate come from one call.
 *
 * `node:crypto` signs but cannot build a certificate, so the DER is assembled
 * here, copied from `gateway/x509.ts` because the relay imports only `node:`
 * modules. Imports only `node:` modules and `relay/`.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { NAMED_DOMAINS } from "./connectTarget.ts";

const KEY_FILE = "intercept-ca-key.pem";
const CERT_FILE = "intercept-ca-cert.pem";
const CA_NAME = "Pandeck relay interception CA";
/** Every leaf's subject: not a host name, so only the SAN is checked. */
const LEAF_NAME = "Pandeck relay interception";
const CA_DAYS = 3650;
const CA_RENEW_DAYS = 30;
const LEAF_DAYS = 30;
const LEAF_RENEW_MS = 86_400_000;
const LEAF_CACHE = 64;
const DAY_MS = 86_400_000;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256))
    bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content);
const octets = (content: Buffer): Buffer => tlv(0x04, content);
const TRUE = tlv(0x01, Buffer.from([0xff]));

function bits(unused: number, content: Buffer): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
}

function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  return tlv(
    0x02,
    trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed,
  );
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const value of rest) {
    const chunk = [value % 128];
    for (let v = Math.floor(value / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift(0x80 | (v % 128));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName)))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [TRUE] : []), octets(value));
}

function ipBytes(ip: string): Buffer {
  if (net.isIPv4(ip)) return Buffer.from(ip.split(".").map(Number));
  // IPv6: expand `::` and write eight 16-bit groups.
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const groups = (part: string | undefined): string[] =>
    part ? part.split(":") : [];
  const left = groups(head);
  const right = groups(tail);
  const all =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  const out = Buffer.alloc(16);
  all.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), i * 2));
  return out;
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

/**
 * The CA's name constraints: `[0]` permitted and `[1]` excluded are IMPLICIT
 * and wrap the GeneralSubtree sequences directly; a dNSName is `[2]`, an
 * iPAddress `[7]` holding address then mask (all zero: every address).
 */
const NAME_CONSTRAINTS = seq(
  tlv(
    0xa0,
    Buffer.concat(
      NAMED_DOMAINS.map((domain) =>
        seq(tlv(0x82, Buffer.from(domain, "ascii"))),
      ),
    ),
  ),
  tlv(
    0xa1,
    Buffer.concat([
      seq(tlv(0x87, Buffer.alloc(8))),
      seq(tlv(0x87, Buffer.alloc(32))),
    ]),
  ),
);
const NAME_CONSTRAINTS_EXTENSION = extension(
  "2.5.29.30",
  true,
  NAME_CONSTRAINTS,
);

/** RFC 5280's key identifier: SHA-1 over the subject public key's bits. */
function keyId(publicKey: KeyObject): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  // An uncompressed P-256 point is the SPKI's last 65 bytes.
  return createHash("sha1")
    .update(spki.subarray(spki.length - 65))
    .digest();
}

interface Issue {
  subject: string;
  publicKey: KeyObject;
  issuerKey: KeyObject;
  days: number;
  extensions: Buffer[];
}

function issue(spec: Issue): string {
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(Date.now() + spec.days * DAY_MS);
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(CA_NAME),
    seq(time(notBefore), time(notAfter)),
    name(spec.subject),
    spec.publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(...spec.extensions)),
  );
  const signature = sign("sha256", tbs, spec.issuerKey);
  const der = seq(tbs, ECDSA_SHA256, bits(0, signature));
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

function issueCa(key: KeyObject): string {
  const publicKey = createPublicKey(key);
  return issue({
    subject: CA_NAME,
    publicKey,
    issuerKey: key,
    days: CA_DAYS,
    extensions: [
      extension("2.5.29.19", true, seq(TRUE, integer(Buffer.from([0])))),
      // keyCertSign and cRLSign.
      extension("2.5.29.15", true, bits(1, Buffer.from([0x06]))),
      NAME_CONSTRAINTS_EXTENSION,
      extension("2.5.29.14", false, octets(keyId(publicKey))),
    ],
  });
}

function newKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function pem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A leaf's key and certificate, from one call: always one pair. */
interface InterceptLeaf {
  key: string;
  cert: string;
}

export interface InterceptCa {
  /** The CA certificate (PEM); never the key. */
  readonly certPem: string;
  /** A leaf for exactly `host`: a DNS name, or an IP address. */
  leafFor(host: string): InterceptLeaf;
}

function caKey(path: string): KeyObject {
  try {
    const key = createPrivateKey(readFileSync(path, "utf8"));
    if (
      key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1"
    )
      return key;
  } catch {
    // The fixed message below; never the file's content.
  }
  throw new Error(
    `${path} is not an EC P-256 private key; delete intercept-ca-* in the relay's state directory and restart.`,
  );
}

/** The stored CA certificate, if it is still this key's and current. */
function storedCa(path: string, key: KeyObject): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const cert = new X509Certificate(text);
    const renewBy = Date.now() + CA_RENEW_DAYS * DAY_MS;
    return cert.ca &&
      cert.checkPrivateKey(key) &&
      cert.raw.includes(NAME_CONSTRAINTS_EXTENSION) &&
      Date.parse(cert.validTo) > renewBy
      ? text
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The relay's interception CA from `stateDir`: made on first use, its key
 * kept, its certificate reissued when needed. An unusable key throws a fixed
 * message naming the file.
 */
export function loadInterceptCa(stateDir: string): InterceptCa {
  const keyPath = join(stateDir, KEY_FILE);
  const certPath = join(stateDir, CERT_FILE);
  let key: KeyObject;
  if (existsSync(keyPath)) key = caKey(keyPath);
  else {
    key = newKey().privateKey;
    writePrivate(keyPath, pem(key));
  }
  let certPem = storedCa(certPath, key);
  if (!certPem) {
    certPem = issueCa(key);
    writePrivate(certPath, certPem);
  }
  const authorityKeyId = extension(
    "2.5.29.35",
    false,
    seq(tlv(0x80, keyId(createPublicKey(key)))),
  );
  const leaves = new Map<string, InterceptLeaf & { renewAt: number }>();
  return {
    certPem,
    leafFor(host) {
      const cached = leaves.get(host);
      if (cached && cached.renewAt > Date.now())
        return { key: cached.key, cert: cached.cert };
      leaves.delete(host);
      const leafKey = newKey();
      const cert = issue({
        subject: LEAF_NAME,
        publicKey: leafKey.publicKey,
        issuerKey: key,
        days: LEAF_DAYS,
        extensions: [
          extension("2.5.29.19", true, seq()),
          // digitalSignature.
          extension("2.5.29.15", true, bits(7, Buffer.from([0x80]))),
          extension("2.5.29.37", false, seq(oid(SERVER_AUTH))),
          extension(
            "2.5.29.17",
            false,
            seq(
              net.isIP(host)
                ? tlv(0x87, ipBytes(host))
                : tlv(0x82, Buffer.from(host, "ascii")),
            ),
          ),
          authorityKeyId,
        ],
      });
      const leaf = { key: pem(leafKey.privateKey), cert };
      while (leaves.size >= LEAF_CACHE)
        leaves.delete(leaves.keys().next().value!);
      leaves.set(host, {
        ...leaf,
        renewAt: Date.now() + LEAF_DAYS * DAY_MS - LEAF_RENEW_MS,
      });
      return leaf;
    },
  };
}

/**
 * Writes the CA certificate, never its key, to `path` for the processes that
 * trust it: 0644, through a temporary file in the same directory and a rename.
 */
export function writeCaCertificate(ca: InterceptCa, path: string): void {
  const temp = join(
    dirname(path),
    `.intercept-ca-${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, ca.certPem, { mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
