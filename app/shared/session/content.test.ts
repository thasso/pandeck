import { describe, expect, it } from "vitest";
import { bodyContentHash } from "./content.ts";
import { sha256Hex } from "./sha256.ts";

describe("body content identity", () => {
  it("computes SHA-256 per the published vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    // Two blocks, multi-byte input, and messages on both sides of the padding
    // edge (55 bytes fits one block with its length; 56 needs a second).
    expect(sha256Hex("a".repeat(1000))).toBe(
      "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
    );
    expect(sha256Hex("\u00e9\u20ac\u{1f600}")).toBe(
      "df9226927fd572c1ee66eec85de1bb139497614899f36e4e90474cb71f6ef9d0",
    );
    expect(sha256Hex("x".repeat(55))).toBe(
      "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072",
    );
    expect(sha256Hex("x".repeat(56))).toBe(
      "04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e",
    );
  });

  it("does not collide where the previous 32-bit checksum did", () => {
    // Same length, and identical under FNV-1a — the pair the review found.
    const a = "Vv-Q(F%10SDJ";
    const b = "3p/b1IB-*Ejm";
    expect(a.length).toBe(b.length);
    expect(bodyContentHash(a)).not.toBe(bodyContentHash(b));
    expect(bodyContentHash(a)).toBe(bodyContentHash("Vv-Q(F%10SDJ"));
    expect(bodyContentHash(a)).toMatch(/^12:sha256:[0-9a-f]{64}$/);
  });
});
