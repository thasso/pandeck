/**
 * Masking credentials a user pasted into a conversation before that text is
 * handed to a helper model: the commit agent's review context and the session
 * status digest both quote session prompts. Also the narrower check that
 * refuses PUBLISHING one: committed patches and caller-written commit messages
 * and pull-request bodies.
 */

/** Token shapes that are credentials wherever they appear. */
const CREDENTIAL_TOKEN_PATTERNS = [
  /\bxox[pbar]-[A-Za-z0-9-]{20,}/,
  /\bghp_[A-Za-z0-9_]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
];

const PUBLISHED_CREDENTIAL_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ...CREDENTIAL_TOKEN_PATTERNS,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*["'][^"']{12,}["']/i,
];

/**
 * Whether text that is about to be PUBLISHED — an added patch line, a
 * caller-written commit message or pull-request body — holds a private key, a
 * known token shape, or a quoted credential assignment. Deliberately narrower
 * than {@link redactCredentials}: a hit refuses publication with no override,
 * so prose that merely mentions a token or password has to pass.
 */
export function textLooksLikeCredential(text: string): boolean {
  return text
    .split("\n")
    .some((line) => PUBLISHED_CREDENTIAL_PATTERNS.some((re) => re.test(line)));
}

/**
 * Mask private keys, known token shapes, HTTP credentials (`Authorization:
 * Bearer …`, a bare `Bearer …`), and the value of any `secret=`/`token:`/
 * `password=`-style assignment however short (e.g. pasted temporary AWS keys),
 * keeping the surrounding text readable.
 */
export function redactCredentials(text: string): string {
  let out = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted private key]",
  );
  for (const re of CREDENTIAL_TOKEN_PATTERNS)
    out = out.replace(new RegExp(re.source, "g"), "[redacted]");
  out = out
    .replace(
      /\b(Authorization["']?\s*[:=]\s*["']?(?:Bearer|Basic|Token|Digest)\s+)[^\s"',;]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, "$1[redacted]");
  return out.replace(
    /\b([\w.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[\w.-]*)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;]*[^\s"',;.!?:)\]]/gi,
    "$1$2[redacted]",
  );
}
