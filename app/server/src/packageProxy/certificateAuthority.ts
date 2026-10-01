/**
 * Certificate material for the package proxy's selective TLS interception.
 *
 * Owns a private CA under `DATA_DIR/package-proxy/` (key mode 0600), issues and
 * caches one leaf certificate per intercepted host, and builds the two trust
 * artifacts build tools need.
 *
 * Both trust artifacts are deliberately COMBINED, never replacements: pointing
 * a tool at our CA alone breaks every host we do NOT intercept (the registry
 * redirects to a CDN presenting a real certificate), which is exactly how the
 * Task-208 spike failed first. So `bundle.pem` is the system CA bundle plus
 * ours, and the JVM truststore is a copy of the JDK's `cacerts` plus ours.
 */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import forge from "node-forge";
import { DATA_DIR } from "../config.ts";
import { errorText } from "../errors.ts";

const execFileAsync = promisify(execFile);

export const PACKAGE_PROXY_DIR = join(DATA_DIR, "package-proxy");
const CA_CERT_PATH = join(PACKAGE_PROXY_DIR, "ca.pem");
const CA_KEY_PATH = join(PACKAGE_PROXY_DIR, "ca.key");
const BUNDLE_PATH = join(PACKAGE_PROXY_DIR, "bundle.pem");
const JVM_TRUSTSTORE_PATH = join(PACKAGE_PROXY_DIR, "jvm-truststore.p12");

/** Password for the JVM truststore. Not a secret: it holds public certificates only. */
export const JVM_TRUSTSTORE_PASSWORD = "changeit";

const CA_VALIDITY_DAYS = 365;
const CA_RENEW_WITHIN_DAYS = 30;
const LEAF_VALIDITY_DAYS = 90;
const CA_SUBJECT = [
  { name: "commonName", value: "Pandeck Package Proxy CA" },
  { name: "organizationName", value: "Pandeck" },
];

/** Candidate system CA bundles, in preference order (NixOS first). */
const SYSTEM_CA_BUNDLES = [
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
];

export interface CertificatePair {
  certPem: string;
  keyPem: string;
}

export interface TrustArtifacts {
  /** PEM bundle: system CAs + our CA. For OpenSSL/curl/Node/git. */
  bundlePath: string;
  /** PKCS12 truststore: JDK cacerts + our CA, or null when no JVM was found. */
  jvmTruststorePath: string | null;
  /** Why the JVM truststore is absent, when it is. */
  jvmReason?: string;
}

function daysFromNow(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Pure and exported for tests: the DER shape is the whole point, and proving it
 * over many samples must not cost an RSA key pair per sample.
 */
export function generateSerial(): string {
  // A DER INTEGER must be positive AND minimally encoded, and node-forge strips
  // at most ONE leading 0x00 from the serial (see the TODO in its asn1.js). So
  // a plain "00" + random prefix encodes as illegal padding whenever the first
  // random byte is 0x00 and the second is < 0x80 — a 1-in-512 CA that OpenSSL
  // then refuses to parse. Forcing the high bit of the leading byte makes the
  // "00" prefix always necessary, hence always minimal: 00 8x .. is the only
  // shape this can produce. 127 bits of entropy is well past the 64 the
  // CA/Browser Forum asks for.
  const bytes = forge.random.getBytesSync(16);
  const leading = bytes.charCodeAt(0) | 0x80;
  return `00${leading.toString(16)}${forge.util.bytesToHex(bytes.slice(1))}`;
}

function createCa(): CertificatePair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerial();
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(CA_VALIDITY_DAYS);
  cert.setSubject(CA_SUBJECT);
  cert.setIssuer(CA_SUBJECT);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/**
 * Whether OpenSSL — not just forge — accepts the certificate. A CA that forge
 * reads back happily but OpenSSL refuses is useless to Node's TLS stack and to
 * every build tool we hand it to, so treat it as absent and reissue rather than
 * serve a broken CA until it expires.
 */
function usableByOpenSsl(certPem: string): boolean {
  try {
    new X509Certificate(certPem);
    return true;
  } catch {
    return false;
  }
}

function expiresWithin(certPem: string, days: number): boolean {
  try {
    return (
      forge.pki.certificateFromPem(certPem).validity.notAfter.getTime() <
      daysFromNow(days).getTime()
    );
  } catch {
    return true;
  }
}

/**
 * Load the CA from `DATA_DIR`, creating (or renewing) it when missing, invalid,
 * or close to expiry. A renewed CA invalidates issued leaves, which is fine:
 * they live in memory only.
 */
export async function loadOrCreateCa(): Promise<CertificatePair> {
  await mkdir(PACKAGE_PROXY_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(CA_CERT_PATH) && existsSync(CA_KEY_PATH)) {
    const [certPem, keyPem] = await Promise.all([
      readFile(CA_CERT_PATH, "utf8"),
      readFile(CA_KEY_PATH, "utf8"),
    ]);
    if (
      usableByOpenSsl(certPem) &&
      !expiresWithin(certPem, CA_RENEW_WITHIN_DAYS)
    )
      return { certPem, keyPem };
  }
  const created = createCa();
  await writeFile(CA_CERT_PATH, created.certPem, {
    encoding: "utf8",
    mode: 0o644,
  });
  await writeFile(CA_KEY_PATH, created.keyPem, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(CA_KEY_PATH, 0o600);
  return created;
}

/** Issue a leaf certificate for one hostname, signed by the CA. */
export function issueLeafCertificate(
  ca: CertificatePair,
  host: string,
): CertificatePair {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerial();
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(LEAF_VALIDITY_DAYS);
  cert.setSubject([{ name: "commonName", value: host }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** In-memory leaf cache; leaves are cheap to reissue and never persisted. */
export function createLeafCertificateCache(
  ca: CertificatePair,
): (host: string) => CertificatePair {
  const cache = new Map<string, CertificatePair>();
  return (host) => {
    const cached = cache.get(host);
    if (cached) return cached;
    const issued = issueLeafCertificate(ca, host);
    cache.set(host, issued);
    return issued;
  };
}

async function readSystemCaBundle(): Promise<string> {
  for (const candidate of SYSTEM_CA_BUNDLES) {
    if (!existsSync(candidate)) continue;
    return await readFile(candidate, "utf8");
  }
  return "";
}

/**
 * Locate the JDK `cacerts` next to the `java` on PATH. Returns null when there
 * is no JVM — nothing then needs a JVM truststore.
 */
async function findJdk(): Promise<{ cacerts: string; keytool: string } | null> {
  try {
    // `java -XshowSettings:properties -version` prints the properties on STDERR
    // (and some JDKs exit non-zero), so both streams must be considered.
    const result = await execFileAsync(
      "java",
      ["-XshowSettings:properties", "-version"],
      { encoding: "utf8" },
    ).catch((err: unknown) => {
      const failure = err as { stdout?: string; stderr?: string };
      if (
        typeof failure?.stderr === "string" ||
        typeof failure?.stdout === "string"
      )
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
      throw err;
    });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const home = /java\.home = (.+)/.exec(combined)?.[1]?.trim();
    if (!home) return null;
    const cacerts = join(home, "lib", "security", "cacerts");
    const keytool = join(home, "bin", "keytool");
    if (!existsSync(cacerts) || !existsSync(keytool)) return null;
    return { cacerts, keytool };
  } catch {
    return null;
  }
}

/**
 * Write `bundle.pem` (system CAs + ours) and, when a JVM is present, a PKCS12
 * truststore (JDK cacerts + ours). Both are rebuilt on every proxy start so a
 * renewed CA or a JDK upgrade cannot leave stale trust material behind.
 */
export async function writeTrustArtifacts(
  ca: CertificatePair,
): Promise<TrustArtifacts> {
  await mkdir(dirname(BUNDLE_PATH), { recursive: true, mode: 0o700 });
  const system = await readSystemCaBundle();
  await writeFile(
    BUNDLE_PATH,
    `${system.trimEnd()}\n${ca.certPem.trimEnd()}\n`,
    { encoding: "utf8", mode: 0o644 },
  );

  const jdk = await findJdk();
  if (!jdk)
    return {
      bundlePath: BUNDLE_PATH,
      jvmTruststorePath: null,
      jvmReason: "no JVM on PATH",
    };
  try {
    await copyFile(jdk.cacerts, JVM_TRUSTSTORE_PATH);
    await chmod(JVM_TRUSTSTORE_PATH, 0o644);
    // keytool refuses to re-add an existing alias, so drop it first (ignore misses).
    await execFileAsync(jdk.keytool, [
      "-delete",
      "-alias",
      "pa-package-proxy",
      "-keystore",
      JVM_TRUSTSTORE_PATH,
      "-storepass",
      JVM_TRUSTSTORE_PASSWORD,
    ]).catch(() => undefined);
    await execFileAsync(jdk.keytool, [
      "-importcert",
      "-noprompt",
      "-alias",
      "pa-package-proxy",
      "-file",
      CA_CERT_PATH,
      "-keystore",
      JVM_TRUSTSTORE_PATH,
      "-storepass",
      JVM_TRUSTSTORE_PASSWORD,
    ]);
    return { bundlePath: BUNDLE_PATH, jvmTruststorePath: JVM_TRUSTSTORE_PATH };
  } catch (err) {
    return {
      bundlePath: BUNDLE_PATH,
      jvmTruststorePath: null,
      jvmReason: `keytool failed: ${errorText(err)}`,
    };
  }
}
