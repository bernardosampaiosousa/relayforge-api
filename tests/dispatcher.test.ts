import { describe, expect, it } from "vitest";
import { processBatch, processDelivery } from "../src/dispatcher.js";
import { UnsafeDestinationError } from "../src/network.js";
import type { ClaimedDelivery } from "../src/types.js";
import { FakeStore } from "./fake-store.js";

function job(attempts = 1): ClaimedDelivery {
  return {
    id: "delivery-123", eventId: "event-123", attempts, eventType: "invoice.paid",
    payload: { amount: 100 }, url: "https://example.com/hook", signingSecret: "test-signing-secret"
  };
}

describe("Webhook worker", () => {
  it("delivers a signed payload and marks 2xx as successful", async () => {
    const store = new FakeStore();
    let signed = "";
    await processDelivery(store, job(), {
      async deliver(_url, payload, headers) {
        expect(JSON.parse(payload)).toEqual({ id: "event-123", type: "invoice.paid", data: { amount: 100 } });
        signed = headers["x-relayforge-signature"]!;
        expect(headers["x-relayforge-event-id"]).toBe("event-123");
        return 204;
      }
    });
    expect(signed).toMatch(/^sha256=/);
    expect(store.delivered).toEqual([{ id: "delivery-123", status: 204, attempt: 1 }]);
    expect(store.retrying).toEqual([]);
  });

  it("retries 5xx responses on a bounded backoff", async () => {
    const store = new FakeStore();
    const now = new Date("2026-11-25T12:00:00Z");
    await processDelivery(store, job(2), { async deliver() { return 503; } }, now);
    expect(store.retrying).toHaveLength(1);
    expect(store.retrying[0]?.status).toBe(503);
    expect(store.retrying[0]?.attempt).toBe(2);
    expect(store.retrying[0]?.when.toISOString()).toBe("2026-11-25T12:02:00.000Z");
  });

  it("retries network errors and stops after max attempts", async () => {
    const store = new FakeStore();
    await processDelivery(store, job(5), { async deliver() { throw new Error("timeout"); } });
    expect(store.failed).toEqual([{ id: "delivery-123", status: null, reason: "timeout", attempt: 5 }]);
    expect(store.retrying).toEqual([]);
  });

  it("does not retry permanent HTTP errors or redirects", async () => {
    const store = new FakeStore();
    await processDelivery(store, job(), { async deliver() { return 400; } });
    await processDelivery(store, { ...job(), id: "redirected" }, { async deliver() { return 302; } });
    expect(store.failed.map(result => result.status)).toEqual([400, 302]);
    expect(store.retrying).toEqual([]);
  });

  it("stops immediately if the destination becomes unsafe", async () => {
    const store = new FakeStore();
    await processDelivery(store, job(), {
      async deliver() { throw new UnsafeDestinationError("Destination resolved to a private IP"); }
    });
    expect(store.failed[0]).toMatchObject({ status: null, attempt: 1 });
    expect(store.retrying).toEqual([]);
  });

  it("claims batches without processing empty queues", async () => {
    const store = new FakeStore();
    expect(await processBatch(store, { async deliver() { return 200; } })).toBe(0);
    store.due.push(job());
    expect(await processBatch(store, { async deliver() { return 200; } })).toBe(1);
    expect(store.delivered).toHaveLength(1);
  });
});
