import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { validateWebhookUrl } from "./security.js";

export class UnsafeDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDestinationError";
  }
}

// BlockList handles CIDR checks for us, including IPv6, without custom IP arithmetic.
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) {
  blockedV4.addSubnet(address, prefix, "ipv4");
}

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]
] as const) {
  blockedV6.addSubnet(address, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
  return false;
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;
const systemResolver: Resolver = hostname => lookup(hostname, { all: true, order: "verbatim" });

export async function resolvePublicAddress(hostname: string, resolver: Resolver = systemResolver): Promise<LookupAddress> {
  const addresses = await resolver(hostname);
  // Reject mixed public/private DNS answers instead of choosing the convenient one.
  if (addresses.length === 0 || addresses.some(item => item.family !== isIP(item.address) || !isPublicAddress(item.address))) {
    throw new UnsafeDestinationError("Webhook hostname must resolve only to public IP addresses");
  }
  return addresses[0]!;
}

export async function sendWebhook(
  destination: string, payload: string, headers: Record<string, string>,
  resolver: Resolver = systemResolver, requestHttps: typeof request = request
): Promise<number> {
  let url: URL;
  try {
    url = new URL(validateWebhookUrl(destination));
  } catch {
    throw new UnsafeDestinationError("Webhook destination is not a public HTTPS URL");
  }

  const address = await resolvePublicAddress(url.hostname, resolver);
  return new Promise<number>((resolve, reject) => {
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      signal: AbortSignal.timeout(6000),
      agent: false,
      autoSelectFamily: false, // We already chose one checked IP; don't ask Node to select addresses again.
      servername: url.hostname,
      // Pin the checked address to the TLS connection. A second DNS lookup could be rebound.
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    } satisfies RequestOptions & { autoSelectFamily: boolean };
    // https.request exposes the socket lookup hook directly, so we can reuse the
    // IP we checked instead of letting a higher-level client resolve it again.
    const outbound = requestHttps(url, options, response => {
      const status = response.statusCode;
      response.destroy(); // Only the status matters; don't let a slow response body hold the worker.
      if (status === undefined) reject(new Error("Webhook response had no HTTP status"));
      else resolve(status);
    });
    outbound.once("error", reject);
    outbound.end(payload);
  });
}
