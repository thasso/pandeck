/**
 * `pandeck-sealed/1` (plan Task-1395): one token file sealed to one or more
 * P-256 recipients, the only form a credential takes on a sealing vault's
 * disk. ECIES with a per-record data key:
 *
 * - a random 32-byte data key encrypts the file with AES-256-GCM; the
 *   associated data binds the version, the account id and the file name, so a
 *   record moved to another account or file does not open;
 * - per recipient, an ephemeral P-256 key, ECDH with the recipient's public
 *   key, and HKDF-SHA256 (salt: the ephemeral point and the recipient's key
 *   id; info `pandeck-sealed/1 wrap`) give the key that wraps the data key,
 *   again AES-256-GCM under the same associated data.
 *
 * A key id is the SHA-256 of the recipient's SubjectPublicKeyInfo (DER), hex.
 * Sealing needs public keys only; opening needs the ECDH result for one
 * recipient, from the YubiKey (`pivChild.ts`) or a software key. Only
 * `node:crypto`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

const SEALED_VERSION = "pandeck-sealed/1";
const WRAP_INFO = `${SEALED_VERSION} wrap`;
const CURVE = "prime256v1";

/** One wrapped data key, base64 fields. */
interface SealedRecipient {
  kid: string;
  /** The ephemeral public key, an uncompressed P-256 point. */
  epk: string;
  iv: string;
  wrapped: string;
  tag: string;
}

export interface SealedRecord {
  v: typeof SEALED_VERSION;
  accountId: string;
  file: string;
  recipients: SealedRecipient[];
  iv: string;
  ct: string;
  tag: string;
}

/** A recipient's public half, as sealing needs it. */
export interface RecipientKey {
  kid: string;
  publicKeyPem: string;
}

/** The ECDH shared secret (the x coordinate) for one wrapped key, if any. */
export type EcdhFor = (
  kid: string,
  epk: Buffer,
) => Buffer | undefined | Promise<Buffer | undefined>;

function p256(key: KeyObject): KeyObject {
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== CURVE
  )
    throw new Error("Not a P-256 key.");
  return key;
}

/** The P-256 public key in `pem` (SPKI or certificate), checked. */
export function recipientPublicKey(pem: string): KeyObject {
  return p256(createPublicKey(pem));
}

/** The key id of a public key: SHA-256 of its SPKI DER, hex. */
export function keyIdOf(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

/** The uncompressed point of a P-256 public key. */
function pointOf(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
}

function associatedData(accountId: string, file: string): Buffer {
  return Buffer.from(JSON.stringify([SEALED_VERSION, accountId, file]));
}

function wrapKey(secret: Buffer, epk: Buffer, kid: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      secret,
      Buffer.concat([epk, Buffer.from(kid, "hex")]),
      WRAP_INFO,
      32,
    ),
  );
}

function gcmSeal(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

/** Throws on any tampering. */
function gcmOpen(
  key: Buffer,
  sealed: { iv: string; ct: string; tag: string },
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64")),
    decipher.final(),
  ]);
}

/** Seals `plaintext`, the file `file` of `accountId`, to every recipient. */
export function sealRecord(
  plaintext: Buffer,
  accountId: string,
  file: string,
  recipients: readonly RecipientKey[],
): SealedRecord {
  if (recipients.length === 0) throw new Error("No recipient to seal to.");
  const aad = associatedData(accountId, file);
  const dataKey = randomBytes(32);
  const body = gcmSeal(dataKey, plaintext, aad);
  return {
    v: SEALED_VERSION,
    accountId,
    file,
    recipients: recipients.map((recipient) => {
      const ephemeral = createECDH(CURVE);
      const epk = ephemeral.generateKeys();
      const secret = ephemeral.computeSecret(
        pointOf(recipientPublicKey(recipient.publicKeyPem)),
      );
      const wrapped = gcmSeal(
        wrapKey(secret, epk, recipient.kid),
        dataKey,
        aad,
      );
      return {
        kid: recipient.kid,
        epk: epk.toString("base64"),
        iv: wrapped.iv,
        wrapped: wrapped.ct,
        tag: wrapped.tag,
      };
    }),
    ...body,
  };
}

/** A parsed record, or undefined when `value` is not one. */
export function parseSealedRecord(value: unknown): SealedRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const strings = (o: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => typeof o[key] === "string");
  if (
    r.v !== SEALED_VERSION ||
    !strings(r, ["accountId", "file", "iv", "ct", "tag"]) ||
    !Array.isArray(r.recipients) ||
    !r.recipients.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        strings(entry as Record<string, unknown>, [
          "kid",
          "epk",
          "iv",
          "wrapped",
          "tag",
        ]),
    )
  )
    return undefined;
  return r as unknown as SealedRecord;
}

/**
 * Opens `record` as the file `file` of `accountId`, through the first of its
 * recipients `ecdh` answers for. Undefined when none does or anything fails to
 * authenticate: tampered fields, another account or file, a wrong key.
 */
export async function openRecord(
  record: SealedRecord,
  accountId: string,
  file: string,
  ecdh: EcdhFor,
): Promise<Buffer | undefined> {
  const aad = associatedData(accountId, file);
  for (const entry of record.recipients) {
    const epk = Buffer.from(entry.epk, "base64");
    const secret = await ecdh(entry.kid, epk);
    if (!secret) continue;
    try {
      const dataKey = gcmOpen(
        wrapKey(secret, epk, entry.kid),
        { iv: entry.iv, ct: entry.wrapped, tag: entry.tag },
        aad,
      );
      return gcmOpen(dataKey, record, aad);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The ECDH of a software private key (PEM) with an ephemeral point. */
export function softwareEcdh(privateKeyPem: string, epk: Buffer): Buffer {
  const key = p256(createPrivateKey(privateKeyPem));
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(
    Buffer.from(key.export({ format: "jwk" }).d!, "base64url"),
  );
  return ecdh.computeSecret(epk);
}
