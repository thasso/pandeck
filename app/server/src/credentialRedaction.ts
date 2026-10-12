/**
 * Masking credentials a user pasted into a conversation before that text is
 * handed to a helper model: the commit agent's review context and the session
 * status digest both quote session prompts.
 */

/** Token shapes that are credentials wherever they appear. */
export const CREDENTIAL_TOKEN_PATTERNS = [
  /\bxox[pbar]-[A-Za-z0-9-]{20,}/,
  /\bghp_[A-Za-z0-9_]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
];

/**
 * Mask private keys, known token shapes, and the value of any
 * `secret=`/`token:`/`password=`-style assignment (e.g. pasted temporary AWS
 * keys), keeping the surrounding text readable.
 */
export function redactCredentials(text: string): string {
  let out = text.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[redacted private key]",
  );
  for (const re of CREDENTIAL_TOKEN_PATTERNS)
    out = out.replace(new RegExp(re.source, "g"), "[redacted]");
  return out.replace(
    /\b([\w.-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key)[\w.-]*)(["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi,
    "$1$2[redacted]",
  );
}
