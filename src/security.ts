import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(24).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex || !/^[0-9a-f]{128}$/i.test(hex)) return false;
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  const original = Buffer.from(hex, "hex");
  return timingSafeEqual(hash, original);
}

export function createSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

export function signWebhook(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** Rejects obvious private destinations. Production deployments also need DNS/egress enforcement. */
export function validateWebhookUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Provide a valid HTTPS URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username || parsed.password ||
    (parsed.port !== "" && parsed.port !== "443") ||
    !hostname || hostname === "localhost" ||
    hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname.endsWith(".internal") || hostname === "metadata.google.internal" ||
    isIP(hostname.replace(/^\[|\]$/g, "")) !== 0
  ) {
    throw new Error("Webhook destinations must be public HTTPS hostnames");
  }
  if (input.length > 2048) throw new Error("Webhook URL is too long");
  parsed.hash = "";
  return parsed.toString();
}
