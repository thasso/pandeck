/**
 * The gateway's own X.509 issuing for mutual TLS (plan M13): a self-signed CA,
 * the edge's server certificate and each enrolled client's certificate, all
 * EC P-256 with ECDSA-SHA256. `node:crypto` signs but cannot build a
 * certificate, so the DER is assembled here; only the fields TLS needs: v3,
 * serial, names with a common name, validity, the key, and basic constraints,
 * key usage, extended key usage and, for the server, its alternative names.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import net from "node:net";

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
const CLIENT_AUTH = "1.3.6.1.5.5.7.3.2";

interface Issue {
  subject: string;
  publicKey: KeyObject;
  issuer: string;
  issuerKey: KeyObject;
  days: number;
  ca?: boolean;
  usage?: typeof SERVER_AUTH | typeof CLIENT_AUTH;
  /** Server alternative names: DNS names and IP addresses. */
  hosts?: string[];
}

function issue(spec: Issue): string {
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(Date.now() + spec.days * 86_400_000);
  const extensions = spec.ca
    ? [
        extension("2.5.29.19", true, seq(TRUE)),
        // keyCertSign and cRLSign.
        extension("2.5.29.15", true, bits(1, Buffer.from([0x06]))),
      ]
    : [
        extension("2.5.29.19", true, seq()),
        // digitalSignature.
        extension("2.5.29.15", true, bits(7, Buffer.from([0x80]))),
        extension("2.5.29.37", false, seq(oid(spec.usage!))),
        ...(spec.hosts?.length
          ? [
              extension(
                "2.5.29.17",
                false,
                seq(
                  ...spec.hosts.map((host) =>
                    net.isIP(host)
                      ? tlv(0x87, ipBytes(host))
                      : tlv(0x82, Buffer.from(host, "ascii")),
                  ),
                ),
              ),
            ]
          : []),
      ];
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name(spec.issuer),
    seq(time(notBefore), time(notAfter)),
    name(spec.subject),
    spec.publicKey.export({ type: "spki", format: "der" }),
    explicit(3, seq(...extensions)),
  );
  const signature = sign("sha256", tbs, spec.issuerKey);
  const der = seq(tbs, ECDSA_SHA256, bits(0, signature));
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

const CA_NAME = "Pandeck gateway CA";
const CA_DAYS = 3650;
const LEAF_DAYS = 825;

export interface EdgeTls {
  caKeyPem: string;
  caCertPem: string;
  serverKeyPem: string;
  serverCertPem: string;
  hosts: string[];
}

function newKey(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function pem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** A new CA, kept as it is, or with a server certificate for `hosts`. */
export function edgeTlsFor(
  hosts: string[],
  existing: EdgeTls | undefined,
): EdgeTls {
  let caKeyPem = existing?.caKeyPem;
  let caCertPem = existing?.caCertPem;
  if (!caKeyPem || !caCertPem) {
    const ca = newKey();
    caKeyPem = pem(ca.privateKey);
    caCertPem = issue({
      subject: CA_NAME,
      publicKey: ca.publicKey,
      issuer: CA_NAME,
      issuerKey: ca.privateKey,
      days: CA_DAYS,
      ca: true,
    });
  }
  if (
    existing &&
    existing.caCertPem === caCertPem &&
    existing.hosts.join(",") === hosts.join(",")
  )
    return existing;
  const server = newKey();
  return {
    caKeyPem,
    caCertPem,
    serverKeyPem: pem(server.privateKey),
    serverCertPem: issue({
      subject: hosts[0] ?? "localhost",
      publicKey: server.publicKey,
      issuer: CA_NAME,
      issuerKey: createPrivateKey(caKeyPem),
      days: LEAF_DAYS,
      usage: SERVER_AUTH,
      hosts,
    }),
    hosts: [...hosts],
  };
}

/**
 * The public key in `publicKeyPem` if it is an EC P-256 SPKI, else undefined.
 * A client key of any other kind is refused at enrollment.
 */
export function clientPublicKey(publicKeyPem: string): KeyObject | undefined {
  try {
    const key = createPublicKey({ key: publicKeyPem, format: "pem" });
    return key.asymmetricKeyType === "ec" &&
      key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      ? key
      : undefined;
  } catch {
    return undefined;
  }
}

/** One side of a pinned link: its key and its self-signed certificate. */
export interface PinnedIdentity {
  keyPem: string;
  certPem: string;
}

/**
 * A new key and a self-signed certificate for one side of the vault link
 * (`gateway-vault/1.0`): the vault's names `hosts` for server auth, the edge's
 * is a client certificate. The peer trusts exactly this certificate (pinned).
 */
export function selfSignedIdentity(
  subject: string,
  side: "server" | "client",
  hosts: string[] = [],
): PinnedIdentity {
  const key = newKey();
  return {
    keyPem: pem(key.privateKey),
    certPem: issue({
      subject,
      publicKey: key.publicKey,
      issuer: subject,
      issuerKey: key.privateKey,
      days: CA_DAYS,
      usage: side === "server" ? SERVER_AUTH : CLIENT_AUTH,
      hosts,
    }),
  };
}

/** A client certificate whose common name is `clientId`. */
export function issueClientCertificate(
  tlsState: EdgeTls,
  clientId: string,
  publicKey: KeyObject,
): { certificatePem: string; fingerprint: string } {
  const certificatePem = issue({
    subject: clientId,
    publicKey,
    issuer: CA_NAME,
    issuerKey: createPrivateKey(tlsState.caKeyPem),
    days: LEAF_DAYS,
    usage: CLIENT_AUTH,
  });
  return {
    certificatePem,
    fingerprint: new X509Certificate(certificatePem).fingerprint256,
  };
}
