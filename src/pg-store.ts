import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HttpError } from "./errors.js";
import type {
  Account, ClaimedDelivery, DeliverySummary, NewEvent, NewWebhookEndpoint,
  QueuedEvent, Repository, WebhookEndpoint
} from "./types.js";

type DbEndpoint = {
  id: string; user_id: string; url: string; event_types: string[];
  enabled: boolean; created_at: Date;
};

function toEndpoint(row: DbEndpoint): WebhookEndpoint {
  return {
    id: row.id,
    userId: row.user_id,
    url: row.url,
    eventTypes: row.event_types,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString()
  };
}

export class PgStore implements Repository {
  constructor(private readonly pool: Pool) {}

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async findUserByEmail(email: string): Promise<Account | null> {
    const result = await this.pool.query<{id: string; email: string; password_hash: string}>(
      "SELECT id, email, password_hash FROM users WHERE email = $1", [email]
    );
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
  }

  async createUser(email: string, passwordHash: string): Promise<Account> {
    const id = randomUUID();
    try {
      await this.pool.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
        [id, email, passwordHash]);
    } catch (error: unknown) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        throw new HttpError(409, "Email is already registered");
      }
      throw error;
    }
    return { id, email, passwordHash };
  }

  async createEndpoint(userId: string, endpoint: NewWebhookEndpoint, secret: string): Promise<WebhookEndpoint> {
    const id = randomUUID();
    const result = await this.pool.query<DbEndpoint>(
      `INSERT INTO endpoints (id, user_id, url, event_types, signing_secret)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, user_id, url, event_types, enabled, created_at`,
      [id, userId, endpoint.url, endpoint.eventTypes, secret]
    );
    return toEndpoint(result.rows[0]!);
  }

  async listEndpoints(userId: string): Promise<WebhookEndpoint[]> {
    const result = await this.pool.query<DbEndpoint>(
      `SELECT id, user_id, url, event_types, enabled, created_at
       FROM endpoints WHERE user_id = $1 ORDER BY created_at DESC`, [userId]
    );
    return result.rows.map(toEndpoint);
  }

  async enqueueEvent(userId: string, event: NewEvent): Promise<QueuedEvent> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const id = randomUUID();
      const payload = JSON.stringify(event.payload);
      const inserted = await client.query<{id: string}>(
        `INSERT INTO events (id, user_id, event_type, payload, idempotency_key)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING id`,
        [id, userId, event.type, payload, event.idempotencyKey]
      );

      if (!inserted.rows[0]) {
        const old = await client.query<{id: string; matches: boolean}>(
          `SELECT id, (event_type = $3 AND payload = $4::jsonb) AS matches
           FROM events WHERE user_id = $1 AND idempotency_key = $2`,
          [userId, event.idempotencyKey, event.type, payload]
        );
        if (!old.rows[0]?.matches) throw new HttpError(409, "Idempotency key reused for different data");
        await client.query("COMMIT");
        return { eventId: old.rows[0].id, deliveriesQueued: 0, duplicate: true };
      }

      const endpoints = await client.query<{id: string}>(
        `SELECT id FROM endpoints WHERE user_id = $1 AND enabled = TRUE AND $2 = ANY(event_types)`,
        [userId, event.type]
      );
      for (const endpoint of endpoints.rows) {
        await client.query(
          "INSERT INTO deliveries (id, event_id, endpoint_id) VALUES ($1, $2, $3)",
          [randomUUID(), id, endpoint.id]
        );
      }
      await client.query("COMMIT");
      return { eventId: id, deliveriesQueued: endpoints.rowCount ?? endpoints.rows.length, duplicate: false };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listDeliveries(userId: string): Promise<DeliverySummary[]> {
    const result = await this.pool.query<{
      id: string; event_id: string; event_type: string; url: string;
      status: DeliverySummary["status"]; attempts: number; response_code: number | null;
      last_error: string | null; updated_at: Date;
    }>(
      `SELECT d.id, d.event_id, ev.event_type, ep.url, d.status, d.attempts,
              d.response_code, d.last_error, d.updated_at
       FROM deliveries d
       JOIN events ev ON ev.id = d.event_id
       JOIN endpoints ep ON ep.id = d.endpoint_id
       WHERE ev.user_id = $1
       ORDER BY d.updated_at DESC LIMIT 100`, [userId]
    );
    return result.rows.map(row => ({
      id: row.id, eventId: row.event_id, eventType: row.event_type,
      endpointUrl: row.url, status: row.status, attempts: row.attempts,
      responseCode: row.response_code, lastError: row.last_error,
      updatedAt: row.updated_at.toISOString()
    }));
  }

  async claimDueDeliveries(limit: number): Promise<ClaimedDelivery[]> {
    const result = await this.pool.query<{
      id: string; event_id: string; attempts: number; event_type: string;
      payload: Record<string, unknown>; url: string; signing_secret: string;
    }>(
      `WITH picked AS (
         SELECT id FROM deliveries
         WHERE (status IN ('pending', 'retrying') AND next_attempt_at <= now())
            OR (status = 'processing' AND updated_at < now() - INTERVAL '3 minutes')
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED LIMIT $1
       ), updated AS (
         UPDATE deliveries d SET status = 'processing', attempts = attempts + 1, updated_at = now()
         FROM picked p WHERE d.id = p.id RETURNING d.*
       )
       SELECT d.id, d.event_id, d.attempts, ev.event_type, ev.payload, ep.url, ep.signing_secret
       FROM updated d
       JOIN events ev ON ev.id = d.event_id
       JOIN endpoints ep ON ep.id = d.endpoint_id`, [limit]
    );
    return result.rows.map(row => ({
      id: row.id, eventId: row.event_id, attempts: row.attempts,
      eventType: row.event_type, payload: row.payload, url: row.url,
      signingSecret: row.signing_secret
    }));
  }

  async markDelivered(id: string, responseCode: number): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries SET status = 'delivered', response_code = $2, last_error = NULL,
       updated_at = now() WHERE id = $1`, [id, responseCode]
    );
  }

  async markFailed(id: string, responseCode: number | null, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries SET status = 'failed', response_code = $2, last_error = $3,
       updated_at = now() WHERE id = $1`, [id, responseCode, reason.slice(0, 500)]
    );
  }

  async markRetrying(id: string, responseCode: number | null, reason: string, retryAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE deliveries SET status = 'retrying', response_code = $2, last_error = $3,
       next_attempt_at = $4, updated_at = now() WHERE id = $1`,
      [id, responseCode, reason.slice(0, 500), retryAt]
    );
  }
}
