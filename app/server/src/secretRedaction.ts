import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { CORE_INTEGRATION_SECRETS } from "./integrationSecrets.ts";

/**
 * Scrubs secrets from text bound for an agent ([Task-729](pa://task/729)).
 * Integration status messages and errors were written for the Settings page,
 * where the user reading them owns the credentials; an endpoint may echo the
 * token it received, and a base URL may carry `user:password@`. Anything an
 * agent tool returns from that world passes through here first.
 *
 * Secrets are found by name rather than by integration, so a new integration's
 * token is covered the day it is stored: every string under a secret-like key
 * in the private settings files, plus the deployment secrets.
 */

const SETTINGS_DIR = join(DATA_DIR, "settings");
/** The shared app settings file holds no secrets, only many ordinary strings. */
const NOT_SECRET_FILES = new Set(["app.json"]);
const SECRET_KEY = /token|secret|key|cookie|password|credential/i;
/** Shorter values are too likely to occur in ordinary text to scrub safely. */
const MIN_SECRET_LENGTH = 8;
const REDACTED = "[redacted]";

interface FileStrings {
  secrets: string[];
  others: string[];
}

function collect(
  value: unknown,
  key: string,
  into: FileStrings,
  minLength: number,
): void {
  if (typeof value === "string") {
    if (value.length < minLength) return;
    (SECRET_KEY.test(key) ? into.secrets : into.others).push(value);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value))
      collect(child, Array.isArray(value) ? key : childKey, into, minLength);
  }
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Every stored secret, in each form it may travel in. Longest first. Text in
 * general only loses secrets of {@link MIN_SECRET_LENGTH} or more, since a
 * short one is likely to occur in ordinary words; a caller scrubbing what one
 * request may have echoed can take a snapshot of every length first.
 */
export function storedSecretForms(minLength = MIN_SECRET_LENGTH): string[] {
  const forms = new Set<string>();
  const add = (secret: string) => {
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(base64(secret));
  };
  for (const value of Object.values(CORE_INTEGRATION_SECRETS))
    if (value.length >= minLength) add(value);
  let files: string[] = [];
  try {
    files = readdirSync(SETTINGS_DIR).filter(
      (name) => name.endsWith(".json") && !NOT_SECRET_FILES.has(name),
    );
  } catch {
    // No settings directory yet: nothing stored to scrub.
  }
  for (const name of files) {
    const strings: FileStrings = { secrets: [], others: [] };
    try {
      collect(
        JSON.parse(readFileSync(join(SETTINGS_DIR, name), "utf8")),
        "",
        strings,
        minLength,
      );
    } catch {
      continue;
    }
    for (const secret of strings.secrets) {
      add(secret);
      // Basic auth sends `user:secret` encoded, e.g. Jira's email and token.
      for (const other of strings.others)
        forms.add(base64(`${other}:${secret}`));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** `text` with the given secret forms and every URL credential and auth header value removed. */
export function redactSecretsWith(
  text: string,
  forms: readonly string[],
): string {
  let out = text
    // Credentials in a URL, plain or percent-encoded. Greedy on purpose: the
    // userinfo ends at the LAST `@` before the path, and a password may hold
    // an unescaped `@` that a URL parser still accepts.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, `$1${REDACTED}@`)
    // Authorization header values.
    .replace(
      /\b(Basic|Bearer|token)(\s+)[A-Za-z0-9+/=._~-]{8,}/g,
      `$1$2${REDACTED}`,
    );
  for (const form of forms) out = out.split(form).join(REDACTED);
  // A message cut short may end partway through a secret.
  for (const form of forms)
    for (let n = Math.min(form.length - 1, out.length); n >= 6; n -= 1)
      if (out.endsWith(form.slice(0, n))) {
        out = `${out.slice(0, -n)}${REDACTED}`;
        break;
      }
  return out;
}

/** `text` with every known secret, URL credential and auth header value removed. */
export function redactSecrets(text: string): string {
  return redactSecretsWith(text, storedSecretForms());
}

/** `value` with {@link redactSecrets} applied to every string inside it. */
export function redactSecretsDeep<T>(value: T): T {
  const forms = storedSecretForms();
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactSecretsWith(node, forms);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object")
      return Object.fromEntries(
        Object.entries(node).map(([key, child]) => [key, walk(child)]),
      );
    return node;
  };
  return walk(value) as T;
}
