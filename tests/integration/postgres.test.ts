import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PgStore } from "../../src/pg-store.js";

let pool: Pool;
let store: PgStore;

describe("webhook persistence with PostgreSQL", () => {
  beforeAll(async () => {
    const rawUrl = process.env.TEST_DATABASE_URL;
    if (!rawUrl) throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL database");
    if (!new URL(rawUrl).pathname.slice(1).endsWith("_test")) {
      throw new Error("Integration tests only run against a database ending in _test");
    }

    pool = new Pool({ connectionString: rawUrl });
    const schema = await readFile(new URL("../../sql/001_init.sql", import.meta.url), "utf8");
    await pool.query(schema);
    store = new PgStore(pool);
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE deliveries, events, endpoints, users CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function queueOneEvent() {
    const user = await store.createUser("test@example.com", "not-used-by-this-test");
    await store.createEndpoint(user.id, {
      url: "https://receiver.example.com/hooks",
      eventTypes: ["order.created"]
    }, "whsec_integration-test-only");
    const event = {
      type: "order.created",
      idempotencyKey: "order-10001",
      payload: { orderId: "10001" }
    };
    const queued = await store.enqueueEvent(user.id, event);
    return { user, event, queued };
  }

  it("does not enqueue a duplicate event", async () => {
    const { user, event, queued } = await queueOneEvent();

    const repeated = await store.enqueueEvent(user.id, event);
    expect(repeated).toMatchObject({
      eventId: queued.eventId,
      deliveriesQueued: 0,
      duplicate: true
    });

    await expect(store.enqueueEvent(user.id, {
      ...event,
      payload: { orderId: "something-else" }
    })).rejects.toMatchObject({ statusCode: 409 });

    const result = await pool.query("SELECT COUNT(*)::int AS count FROM deliveries");
    expect(result.rows[0].count).toBe(1);
  });

  it("allows only one worker to claim a pending delivery", async () => {
    await queueOneEvent();

    const [first, second] = await Promise.all([
      store.claimDueDeliveries(1),
      store.claimDueDeliveries(1)
    ]);
    const claimed = [...first, ...second];
    expect(claimed).toHaveLength(1);
    expect(claimed[0].attempts).toBe(1);

    await store.markDelivered(claimed[0].id, 200);
    const result = await pool.query("SELECT status, attempts FROM deliveries");
    expect(result.rows[0]).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("reclaims a stuck delivery after a worker stops", async () => {
    await queueOneEvent();
    const first = (await store.claimDueDeliveries(1))[0];
    await pool.query(
      "UPDATE deliveries SET updated_at = now() - INTERVAL '4 minutes' WHERE id = $1",
      [first.id]
    );

    const reclaimed = await store.claimDueDeliveries(1);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ id: first.id, attempts: 2 });
  });
});
