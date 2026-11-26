/**
 * Image headers built by hand from each format's layout, for the `/mcp` file
 * result's classifier (Task-1441 P7b). Only the bytes a parser reads are
 * real; the rest of a file is filler. Every value is fake.
 */

const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

/** A PNG's signature and IHDR chunk for `width` × `height`. */
export function pngHeader(width: number, height: number): number[] {
  return [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...be32(13),
    ...[..."IHDR"].map((char) => char.charCodeAt(0)),
    ...be32(width),
    ...be32(height),
    8,
    6,
    0,
    0,
    0,
  ];
}

/** `pngHeader` followed by filler bytes up to `size`. */
export function pngOf(width: number, height: number, size: number): Uint8Array {
  const head = pngHeader(width, height);
  const bytes = new Uint8Array(Math.max(size, head.length)).map(
    (_byte, index) => (index * 31 + 7) % 256,
  );
  bytes.set(head);
  return bytes;
}
