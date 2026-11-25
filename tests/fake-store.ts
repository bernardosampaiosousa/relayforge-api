import { randomUUID } from "node:crypto";
import { HttpError } from "../src/errors.js";
import type {
  Account, ClaimedDelivery, DeliverySummary, NewEvent, NewWebhookEndpoint,
  QueuedEvent, Repository, WebhookEndpoint
} from "../src/types.js";

export class FakeStore implements Repository {
  users = new Map<string, Account>();
  endpoints: WebhookEndpoint[] = [];
  eventKeys = new Map<string, { event: NewEvent; result: QueuedEvent }>();
  deliveries: DeliverySummary[] = [];
  deliveryOwners = new Map<string, string>();
  due: ClaimedDelivery[] = [];
  delivered: { id: string; status: number }[] = [];
  failed: { id: string; status: number | null; reason: string }[] = [];
  retrying: { id: string; status: number | null; reason: string; when: Date }[] = [];

  async ping(): Promise<void> {}

  async findUserByEmail(email: string): Promise<Account | null> {
    return this.users.get(email) ?? null;
  }

  async createUser(email: string, passwordHash: string): Promise<Account> {
    const account = { id: randomUUID(), email, passwordHash };
    this.users.set(email, account);
    return account;
  }

  async createEndpoint(userId: string, input: NewWebhookEndpoint, _secret: string): Promise<WebhookEndpoint> {
    const endpoint = { id: randomUUID(), userId, url: input.url, eventTypes: input.eventTypes,
      enabled: true, createdAt: new Date().toISOString() };
    this.endpoints.push(endpoint);
    return endpoint;
  }

  async listEndpoints(userId: string): Promise<WebhookEndpoint[]> {
    return this.endpoints.filter(endpoint => endpoint.userId === userId);
  }

  async enqueueEvent(userId: string, event: NewEvent): Promise<QueuedEvent> {
    const key = `${userId}:${event.idempotencyKey}`;
    const old = this.eventKeys.get(key);
    if (old) {
      if (old.event.type !== event.type || JSON.stringify(old.event.payload) !== JSON.stringify(event.payload)) {
        throw new HttpError(409, "Idempotency key reused for different data");
      }
      return { ...old.result, duplicate: true, deliveriesQueued: 0 };
    }
    const matching = this.endpoints.filter(e => e.userId === userId && e.eventTypes.includes(event.type));
    const queued = { eventId: randomUUID(), duplicate: false,
      deliveriesQueued: matching.length };
    this.eventKeys.set(key, { event, result: queued });
    for (const endpoint of matching) {
      const id = randomUUID();
      this.deliveryOwners.set(id, userId);
      this.deliveries.push({ id, eventId: queued.eventId, eventType: event.type,
        endpointUrl: endpoint.url, status: "pending", attempts: 0, responseCode: null,
        lastError: null, updatedAt: new Date().toISOString() });
    }
    return queued;
  }

  async listDeliveries(userId: string): Promise<DeliverySummary[]> {
    return this.deliveries.filter(d => this.deliveryOwners.get(d.id) === userId);
  }
  async claimDueDeliveries(limit: number): Promise<ClaimedDelivery[]> { return this.due.splice(0, limit); }
  async markDelivered(id: string, responseCode: number): Promise<void> {
    this.delivered.push({ id, status: responseCode });
  }
  async markFailed(id: string, responseCode: number | null, reason: string): Promise<void> {
    this.failed.push({ id, status: responseCode, reason });
  }
  async markRetrying(id: string, responseCode: number | null, reason: string, retryAt: Date): Promise<void> {
    this.retrying.push({ id, status: responseCode, reason, when: retryAt });
  }
}
