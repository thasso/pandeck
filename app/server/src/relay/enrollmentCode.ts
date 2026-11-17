import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/** A devbox owner's Google access token: 1-2048 printable ASCII characters. */
const OWNER_TOKEN_RE = /^[\x21-\x7e]{1,2048}$/;
/** The owner token file's size before trimming: the token and some space. */
const MAX_OWNER_TOKEN_FILE = 4096;

/**
 * A secret read from stdin (no path) or from an owner-only regular file,
 * opened without following a symlink, of at most `maxBytes`.
 */
function readPrivateText(
  path: string | undefined,
  maxBytes: number,
  refusal: string,
): string {
  let text: string;
  if (path === undefined) text = readFileSync(0, "utf8");
  else {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > maxBytes
      )
        throw new Error(refusal);
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  if (Buffer.byteLength(text) > maxBytes) throw new Error(refusal);
  return text;
}

/** Enrollment secrets never come from argv. A named file must be owner-only. */
export function readEnrollmentCode(path?: string): string {
  const code = readPrivateText(
    path,
    512,
    "The enrollment code file must be a 0600 file of at most 512 bytes.",
  ).trim();
  if (!code || code.length > 512 || /\s/.test(code))
    throw new Error("Supply one enrollment code through stdin or --code-file.");
  return code;
}

/**
 * A devbox owner's Google access token (Task-1410 PR2) from
 * `--owner-token-file`: `-` reads stdin, anything else a 0600 regular file.
 * Undefined when empty, so the machine asks for browser approval. Never
 * written anywhere and never in a refusal.
 */
export function readOwnerToken(path: string): string | undefined {
  const token = readPrivateText(
    path === "-" ? undefined : path,
    MAX_OWNER_TOKEN_FILE,
    `The owner token file must be a 0600 file of at most ${MAX_OWNER_TOKEN_FILE} bytes.`,
  ).trim();
  if (token === "") return undefined;
  if (!OWNER_TOKEN_RE.test(token))
    throw new Error(
      "The owner token must be 1-2048 printable ASCII characters without spaces.",
    );
  return token;
}
