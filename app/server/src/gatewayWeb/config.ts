/**
 * The gateway UI's deployment file (`--ui-config`, Task-1402): the browser
 * port and origin, the browser certificate, the OIDC client and the rule that
 * admits an account. One 0600 file, so the client secret stays out of argv.
 * Every refusal is a fixed message that echoes nothing from the file.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Which accounts the deployment admits; see `admittedEmail`. */
export interface AllowRule {
  /** Lowercased, without `@`. */
  emailDomains: string[];
  /** Lowercased. */
  emails: string[];
  /** Top-level string claims the ID token must carry exactly. */
  claims: Record<string, string>;
}

export interface GatewayWebConfig {
  /** 0 picks a free port. */
  port: number;
  /** `https://host[:port]`, what the browser shows; the redirect URI's base. */
  publicOrigin: string;
  certPem: string;
  keyPem: string;
  /** The built gateway entry (`defaultDistDir` unless the file names one). */
  distDir: string;
  oidc: { issuer: string; clientId: string; clientSecret: string };
  allow: AllowRule;
}

export class GatewayWebConfigError extends Error {}

/**
 * Where the built gateway entry is when the file names none: under a `.ts`
 * module, `app/web/dist-gateway` in this checkout; in the Bun package,
 * `gateway-web/` beside the bundle (`docs/deployment.md#bun-package`).
 */
export function defaultDistDir(moduleUrl: string = import.meta.url): string {
  return fileURLToPath(
    new URL(
      moduleUrl.endsWith(".ts") ? "../../../web/dist-gateway" : "./gateway-web",
      moduleUrl,
    ),
  );
}

function refuse(message: string): never {
  throw new GatewayWebConfigError(`gateway UI config: ${message}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    refuse(`${field} must be a non-empty string`);
  return value.trim();
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    refuse(`${field} must be a list of strings`);
  return (value as string[])
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");
}

function httpsUrl(value: unknown, field: string): URL {
  let url: URL;
  try {
    url = new URL(text(value, field));
  } catch {
    refuse(`${field} must be an https:// URL`);
  }
  if (url.protocol !== "https:") refuse(`${field} must be an https:// URL`);
  return url;
}

function pem(file: unknown, field: string): string {
  const path = text(file, field);
  try {
    return readFileSync(path, "utf8");
  } catch {
    refuse(`${field} cannot be read`);
  }
}

/** The rule, checked; an empty one would admit nobody and refuses to start. */
function allowRule(value: unknown): AllowRule {
  if (typeof value !== "object" || value === null)
    refuse("allow must be an object");
  const raw = value as Record<string, unknown>;
  const emailDomains = strings(raw.emailDomains, "allow.emailDomains");
  const emails = strings(raw.emails, "allow.emails");
  if (emailDomains.length === 0 && emails.length === 0)
    refuse("allow needs at least one of emailDomains and emails");
  if (emailDomains.some((domain) => domain.includes("@")))
    refuse("allow.emailDomains holds domains without @");
  if (emails.some((email) => email.lastIndexOf("@") <= 0))
    refuse("allow.emails holds email addresses");
  const claims: Record<string, string> = {};
  if (raw.claims !== undefined) {
    if (typeof raw.claims !== "object" || raw.claims === null)
      refuse("allow.claims must be an object of strings");
    for (const [name, expected] of Object.entries(raw.claims)) {
      if (typeof expected !== "string")
        refuse("allow.claims must be an object of strings");
      claims[name] = expected;
    }
  }
  return { emailDomains, emails, claims };
}

/** Reads and checks the UI config at `file`; throws `GatewayWebConfigError`. */
export function loadGatewayWebConfig(file: string): GatewayWebConfig {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    refuse("the file cannot be read");
  }
  if ((mode & 0o077) !== 0)
    refuse("the file must not be accessible by group or others (chmod 600)");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    refuse("the file is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null)
    refuse("the file must hold an object");

  const port = raw.port ?? 443;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0)
    refuse("port must be an integer from 0 to 65535");
  if (port > 65_535) refuse("port must be an integer from 0 to 65535");

  const origin = httpsUrl(raw.publicOrigin, "publicOrigin");
  if (origin.href !== `${origin.origin}/` || raw.publicOrigin !== origin.origin)
    refuse("publicOrigin must be https://host[:port] with no path");

  if (typeof raw.oidc !== "object" || raw.oidc === null)
    refuse("oidc must be an object");
  const oidc = raw.oidc as Record<string, unknown>;
  httpsUrl(oidc.issuer, "oidc.issuer");
  const clientId = text(oidc.clientId, "oidc.clientId");
  const clientSecret = text(oidc.clientSecret, "oidc.clientSecret");
  const allow = allowRule(raw.allow);

  const certPem = pem(raw.certFile, "certFile");
  const keyPem = pem(raw.keyFile, "keyFile");
  const distDir =
    raw.distDir === undefined ? defaultDistDir() : text(raw.distDir, "distDir");
  if (!existsSync(join(distDir, "gateway.html")))
    refuse("distDir holds no gateway.html (run pnpm run build)");

  return {
    port,
    publicOrigin: origin.origin,
    certPem,
    keyPem,
    distDir,
    oidc: { issuer: text(oidc.issuer, "oidc.issuer"), clientId, clientSecret },
    allow,
  };
}

/**
 * The lowercased email of an ID token the rule admits, else undefined:
 * `email_verified` must be the boolean `true`, `email` a string matching an
 * exact address or a domain, and every configured claim equal.
 */
export function admittedEmail(
  allow: AllowRule,
  claims: Record<string, unknown>,
): string | undefined {
  if (claims.email_verified !== true) return undefined;
  if (typeof claims.email !== "string") return undefined;
  const email = claims.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  if (
    !allow.emails.includes(email) &&
    !allow.emailDomains.includes(email.slice(at + 1))
  )
    return undefined;
  for (const [name, expected] of Object.entries(allow.claims))
    if (claims[name] !== expected) return undefined;
  return email;
}
