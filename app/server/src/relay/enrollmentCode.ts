import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

/** Enrollment secrets never come from argv. A named file must be owner-only. */
export function readEnrollmentCode(path?: string): string {
  let text: string;
  if (path === undefined) text = readFileSync(0, "utf8");
  else {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 512)
        throw new Error(
          "The enrollment code file must be a 0600 file of at most 512 bytes.",
        );
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  const code = text.trim();
  if (!code || code.length > 512 || /\s/.test(code))
    throw new Error("Supply one enrollment code through stdin or --code-file.");
  return code;
}
