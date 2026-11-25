import { describe, expect, it } from "vitest";
import { createSigningSecret, hashPassword, signWebhook, validateWebhookUrl, verifyPassword } from "../src/security.js";
import { MAX_ATTEMPTS, retryDelayMs } from "../src/retry.js";

describe("Security primitives", () => {
  it("hashes passwords with random salt", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("wrong-password", a)).toBe(false);
    expect(await verifyPassword("any-password", "garbage")).toBe(false);
  });

  it("generates unique webhook signing secrets", () => {
    expect(createSigningSecret()).not.toBe(createSigningSecret());
  });

  it("creates a deterministic HMAC-SHA256 signature", () => {
    const sig = signWebhook('{"hello":"world"}', "a-secret");
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(signWebhook('{"hello":"world"}', "a-secret")).toBe(sig);
    expect(signWebhook('{"hello":"other"}', "a-secret")).not.toBe(sig);
  });

  it("normalizes public HTTPS URLs and blocks nonpublic destinations", () => {
    expect(validateWebhookUrl("https://example.com/hooks#fragment")).toBe("https://example.com/hooks");
    for (const input of ["http://example.com", "https://localhost/test", "https://10.0.0.1/test",
      "https://[::1]/test", "https://admin:pass@example.com/test", "https://service.internal/test"] ) {
      expect(() => validateWebhookUrl(input)).toThrow();
    }
  });
});

describe("Delivery retry policy", () => {
  it("applies bounded exponential backoff", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([30_000, 120_000, 480_000, 1_800_000, 1_800_000]);
    expect(MAX_ATTEMPTS).toBe(5);
  });

  it("rejects invalid attempt numbers", () => {
    expect(() => retryDelayMs(0)).toThrow();
    expect(() => retryDelayMs(1.5)).toThrow();
  });
});
