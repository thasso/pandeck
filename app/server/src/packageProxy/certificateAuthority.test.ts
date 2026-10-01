import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import forge from "node-forge";
import { describe, expect, test } from "vitest";
import {
  generateSerial,
  issueLeafCertificate,
  createLeafCertificateCache,
  loadOrCreateCa,
  writeTrustArtifacts,
  PACKAGE_PROXY_DIR,
} from "./certificateAuthority.ts";

describe("package proxy certificate authority", () => {
  test("creates a CA once and reuses it, with the key kept private", async () => {
    const first = await loadOrCreateCa();
    const second = await loadOrCreateCa();

    expect(second.certPem).toBe(first.certPem);
    const cert = new X509Certificate(first.certPem);
    expect(cert.ca).toBe(true);
    expect(cert.subject).toContain("Pandeck Package Proxy CA");
    expect(statSync(`${PACKAGE_PROXY_DIR}/ca.key`).mode & 0o777).toBe(0o600);
  });

  test("issues host leaves signed by the CA, with the host as a SAN", async () => {
    const ca = await loadOrCreateCa();

    const leaf = issueLeafCertificate(ca, "maven.pkg.github.com");

    const cert = new X509Certificate(leaf.certPem);
    expect(cert.subjectAltName).toBe("DNS:maven.pkg.github.com");
    expect(cert.ca).toBe(false);
    expect(cert.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    expect(cert.checkHost("maven.pkg.github.com")).toBe("maven.pkg.github.com");
    expect(cert.checkHost("evil.example.com")).toBeUndefined();
  });

  test("always issues a serial OpenSSL reads as a minimal positive INTEGER", () => {
    // node-forge strips at most one leading 0x00, so a serial whose first two
    // random bytes were 00 xx (xx < 0x80) used to survive as illegal padding
    // and fail X509Certificate parsing on roughly one CA in 512.
    for (let i = 0; i < 5000; i++) {
      const serial = generateSerial();
      expect(serial).toHaveLength(34);
      expect(serial.slice(0, 2)).toBe("00");
      // The prefix must be NECESSARY: the next byte carries the sign bit, so
      // forge cannot strip it and the encoding stays minimal.
      expect(Number.parseInt(serial.slice(2, 4), 16) & 0x80).toBe(0x80);
    }
  });

  test("caches one leaf per host so key and certificate always pair up", async () => {
    const ca = await loadOrCreateCa();
    const leafFor = createLeafCertificateCache(ca);

    const a = leafFor("npm.pkg.github.com");
    const b = leafFor("npm.pkg.github.com");

    expect(b).toBe(a);
    expect(leafFor("nuget.pkg.github.com").certPem).not.toBe(a.certPem);
  });

  test("writes a COMBINED PEM bundle, not just our CA", async () => {
    const ca = await loadOrCreateCa();

    const trust = await writeTrustArtifacts(ca);

    const bundle = readFileSync(trust.bundlePath, "utf8");
    expect(bundle).toContain(ca.certPem.trimEnd());
    // A bundle holding only our CA would break every host we do NOT intercept.
    const certificates = bundle.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
    expect(certificates.length).toBeGreaterThan(1);
  });

  // Last: it replaces the stored CA, and the reissue leaves a usable one.
  test("reissues a stored CA that OpenSSL cannot parse", async () => {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const broken = forge.pki.createCertificate();
    broken.publicKey = keys.publicKey;
    // Forge strips one of these two leading zero bytes, leaving illegal
    // padding before 0x01. Keep the malformed serial deterministic: a random
    // next byte with its high bit set would make the remaining zero necessary.
    broken.serialNumber = `000001${"00".repeat(14)}`;
    broken.validity.notBefore = new Date(Date.now() - 86_400_000);
    broken.validity.notAfter = new Date(Date.now() + 300 * 86_400_000);
    const subject = [{ name: "commonName", value: "broken" }];
    broken.setSubject(subject);
    broken.setIssuer(subject);
    broken.setExtensions([{ name: "basicConstraints", cA: true }]);
    broken.sign(keys.privateKey, forge.md.sha256.create());
    const brokenPem = forge.pki.certificateToPem(broken);
    // Guard the premise: forge reads this back, OpenSSL must not.
    expect(() => forge.pki.certificateFromPem(brokenPem)).not.toThrow();
    expect(() => new X509Certificate(brokenPem)).toThrow();

    await mkdir(PACKAGE_PROXY_DIR, { recursive: true, mode: 0o700 });
    await writeFile(`${PACKAGE_PROXY_DIR}/ca.pem`, brokenPem, "utf8");
    await writeFile(
      `${PACKAGE_PROXY_DIR}/ca.key`,
      forge.pki.privateKeyToPem(keys.privateKey),
      "utf8",
    );

    const ca = await loadOrCreateCa();

    expect(ca.certPem).not.toBe(brokenPem);
    expect(new X509Certificate(ca.certPem).ca).toBe(true);
  });
});
