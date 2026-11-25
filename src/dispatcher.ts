import { signWebhook } from "./security.js";
import { MAX_ATTEMPTS, retryAtFrom } from "./retry.js";
import type { ClaimedDelivery, Repository } from "./types.js";

export interface DeliveryTransport {
  deliver(destination: string, payload: string, headers: Record<string, string>): Promise<number>;
}

export const fetchTransport: DeliveryTransport = {
  async deliver(destination, payload, headers) {
    const response = await fetch(destination, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(6000)
    });
    return response.status;
  }
};

export async function processDelivery(
  repository: Repository,
  delivery: ClaimedDelivery,
  transport: DeliveryTransport,
  now: Date = new Date()
): Promise<void> {
  const body = JSON.stringify({ id: delivery.eventId, type: delivery.eventType, data: delivery.payload });
  let status: number | null = null;
  let reason = "";

  try {
    status = await transport.deliver(delivery.url, body, {
      "x-relayforge-event-id": delivery.eventId,
      "x-relayforge-attempt": String(delivery.attempts),
      "x-relayforge-signature": signWebhook(body, delivery.signingSecret)
    });
    if (status >= 200 && status < 300) {
      await repository.markDelivered(delivery.id, status);
      return;
    }
    reason = `Destination returned HTTP ${status}`;
  } catch (error: unknown) {
    reason = error instanceof Error ? error.message : "Delivery failed";
  }

  if (delivery.attempts >= MAX_ATTEMPTS) {
    await repository.markFailed(delivery.id, status, reason);
  } else {
    await repository.markRetrying(delivery.id, status, reason, retryAtFrom(delivery.attempts, now));
  }
}

export async function processBatch(
  repository: Repository,
  transport: DeliveryTransport = fetchTransport,
  limit = 20
): Promise<number> {
  const deliveries = await repository.claimDueDeliveries(limit);
  for (const delivery of deliveries) {
    // A failed delivery should not stop subsequent jobs in the same batch.
    await processDelivery(repository, delivery, transport);
  }
  return deliveries.length;
}
