export interface Account {
  id: string;
  email: string;
  passwordHash: string;
}

export interface WebhookEndpoint {
  id: string;
  userId: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  createdAt: string;
}

export interface NewWebhookEndpoint {
  url: string;
  eventTypes: string[];
}

export interface QueuedEvent {
  eventId: string;
  deliveriesQueued: number;
  duplicate: boolean;
}

export interface NewEvent {
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export type DeliveryStatus = "pending" | "processing" | "retrying" | "delivered" | "failed";

export interface DeliverySummary {
  id: string;
  eventId: string;
  eventType: string;
  endpointUrl: string;
  status: DeliveryStatus;
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  updatedAt: string;
}

export interface ClaimedDelivery {
  id: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  url: string;
  signingSecret: string;
  attempts: number;
}

/** Domain-facing persistence interface. The worker and HTTP app can be tested without a database. */
export interface Repository {
  findUserByEmail(email: string): Promise<Account | null>;
  createUser(email: string, passwordHash: string): Promise<Account>;
  createEndpoint(userId: string, endpoint: NewWebhookEndpoint, secret: string): Promise<WebhookEndpoint>;
  listEndpoints(userId: string): Promise<WebhookEndpoint[]>;
  enqueueEvent(userId: string, event: NewEvent): Promise<QueuedEvent>;
  listDeliveries(userId: string): Promise<DeliverySummary[]>;
  claimDueDeliveries(limit: number): Promise<ClaimedDelivery[]>;
  markDelivered(id: string, responseCode: number): Promise<void>;
  markFailed(id: string, responseCode: number | null, reason: string): Promise<void>;
  markRetrying(id: string, responseCode: number | null, reason: string, retryAt: Date): Promise<void>;
  ping(): Promise<void>;
}
