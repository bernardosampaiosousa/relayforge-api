import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { FakeStore } from "./fake-store.js";

const secret = "a-realistic-test-secret-over-thirty-two-characters-long";

describe("RelayForge HTTP API", () => {
  let app: FastifyInstance;
  let store: FakeStore;

  beforeEach(async () => {
    store = new FakeStore();
    app = await createApp({ repository: store, jwtSecret: secret });
  });

  afterEach(async () => { await app.close(); });

  async function register(email = "bernardo@example.com"): Promise<string> {
    const response = await app.inject({ method: "POST", url: "/auth/register",
      payload: { email, password: "correct-horse-battery-staple" } });
    expect(response.statusCode).toBe(201);
    return response.json().token as string;
  }

  it("provides liveness, readiness and Swagger documentation", async () => {
    expect((await app.inject("/health")).statusCode).toBe(200);
    expect((await app.inject("/ready")).statusCode).toBe(200);
    const docs = await app.inject("/docs/json");
    expect(docs.statusCode).toBe(200);
    expect(docs.json().paths["/v1/events"]).toBeDefined();
  });

  it("validates registration input", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/register",
      payload: { email: "invalid", password: "weak" } });
    expect(response.statusCode).toBe(400);
  });

  it("creates accounts and rejects duplicate registration", async () => {
    await register();
    const duplicate = await app.inject({ method: "POST", url: "/auth/register",
      payload: { email: "bernardo@example.com", password: "correct-horse-battery-staple" } });
    expect(duplicate.statusCode).toBe(409);
  });

  it("signs in with correct credentials and rejects wrong passwords", async () => {
    await register();
    const valid = await app.inject({ method: "POST", url: "/auth/login",
      payload: { email: "bernardo@example.com", password: "correct-horse-battery-staple" } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().tokenType).toBe("Bearer");
    const invalid = await app.inject({ method: "POST", url: "/auth/login",
      payload: { email: "bernardo@example.com", password: "incorrect-password" } });
    expect(invalid.statusCode).toBe(401);
  });

  it("protects all private API routes", async () => {
    for (const [method, url] of [["GET", "/v1/endpoints"], ["GET", "/v1/deliveries"], ["POST", "/v1/events"]]) {
      const response = await app.inject({ method: method as "GET" | "POST", url, payload: method === "POST" ? {} : undefined });
      expect(response.statusCode).toBe(401);
    }
  });

  it("creates an HTTPS endpoint, exposes its signing secret only once", async () => {
    const token = await register();
    const headers = { authorization: `Bearer ${token}` };
    const created = await app.inject({ method: "POST", url: "/v1/endpoints", headers,
      payload: { url: "https://example.com/my-webhook", eventTypes: ["order.created"] } });
    expect(created.statusCode).toBe(201);
    expect(created.json().signingSecret).toMatch(/^whsec_/);
    const list = await app.inject({ method: "GET", url: "/v1/endpoints", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain("signingSecret");
  });

  it("rejects private destinations and disallowed HTTP URLs", async () => {
    const token = await register();
    for (const url of ["http://localhost:8080", "https://127.0.0.1/hook", "https://[::1]/hook", "https://metadata.google.internal/"]) {
      const response = await app.inject({ method: "POST", url: "/v1/endpoints",
        headers: { authorization: `Bearer ${token}` },
        payload: { url, eventTypes: ["order.created"] } });
      expect(response.statusCode).toBe(400);
    }
  });

  it("queues events once per idempotency key", async () => {
    const token = await register();
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({ method: "POST", url: "/v1/endpoints", headers,
      payload: { url: "https://example.com/hooks", eventTypes: ["order.created"] } });
    const payload = { type: "order.created", idempotencyKey: "order-10001", payload: { orderId: 10001 } };
    const first = await app.inject({ method: "POST", url: "/v1/events", headers, payload });
    const second = await app.inject({ method: "POST", url: "/v1/events", headers, payload });
    expect(first.statusCode).toBe(202);
    expect(first.json().deliveriesQueued).toBe(1);
    expect(second.json()).toMatchObject({ eventId: first.json().eventId, duplicate: true, deliveriesQueued: 0 });
  });

  it("rejects conflicting data for an existing idempotency key", async () => {
    const token = await register();
    const headers = { authorization: `Bearer ${token}` };
    const initial = { type: "invoice.paid", idempotencyKey: "invoice-10001", payload: { amount: 100 } };
    expect((await app.inject({ method: "POST", url: "/v1/events", headers, payload: initial })).statusCode).toBe(202);
    const conflict = await app.inject({ method: "POST", url: "/v1/events", headers,
      payload: { ...initial, payload: { amount: 200 } } });
    expect(conflict.statusCode).toBe(409);
  });

  it("shows queued deliveries only to the owning account", async () => {
    const firstToken = await register();
    const secondToken = await register("second@example.com");
    const headers = { authorization: `Bearer ${firstToken}` };
    await app.inject({ method: "POST", url: "/v1/endpoints", headers,
      payload: { url: "https://example.com/hooks", eventTypes: ["invoice.paid"] } });
    await app.inject({ method: "POST", url: "/v1/events", headers,
      payload: { type: "invoice.paid", idempotencyKey: "invoice-10002", payload: { amount: 350 } } });
    const mine = await app.inject({ method: "GET", url: "/v1/deliveries", headers });
    const others = await app.inject({ method: "GET", url: "/v1/deliveries",
      headers: { authorization: `Bearer ${secondToken}` } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toHaveLength(1);
    expect(mine.json()[0]).toMatchObject({ eventType: "invoice.paid", status: "pending" });
    expect(others.json()).toEqual([]);
  });

  it("does not expose another account's endpoints", async () => {
    const firstToken = await register();
    const secondToken = await register("someoneelse@example.com");
    await app.inject({ method: "POST", url: "/v1/endpoints",
      headers: { authorization: `Bearer ${firstToken}` },
      payload: { url: "https://example.com/hooks", eventTypes: ["order.created"] } });
    const response = await app.inject({ method: "GET", url: "/v1/endpoints",
      headers: { authorization: `Bearer ${secondToken}` } });
    expect(response.json()).toEqual([]);
  });
});
