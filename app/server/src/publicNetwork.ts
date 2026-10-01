import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Refuse hosts that resolve to loopback, private, link-local, CGNAT or reserved space. */
export async function assertPublicHost(
  hostname: string,
  caller: string,
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (addresses.length === 0)
    throw new Error(`${caller} could not resolve host: ${hostname}`);
  for (const address of addresses)
    if (isPrivateAddress(address))
      throw new Error(
        `${caller} refuses to reach a non-public address (${hostname} -> ${address}).`,
      );
}

async function resolveHost(hostname: string): Promise<string[]> {
  if (/^localhost$|\.localhost$/i.test(hostname)) return ["127.0.0.1"];
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateIPv4(address);
  if (kind === 6) return isPrivateIPv6(address);
  return true;
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map((octet) => Number(octet));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return true;
  const a = octets[0]!;
  const b = octets[1]!;
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return a >= 224;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::") return true;
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  if (value.startsWith("fe80")) return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  return value.startsWith("ff");
}
