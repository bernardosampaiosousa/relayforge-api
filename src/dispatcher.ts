import { signWebhook } from "./security.js";
import { sendWebhook, UnsafeDestinationError } from "./network.js";
import { MAX_ATTEMPTS, retryAtFrom } from "./retry.js";
import type { ClaimedDelivery, Repository } from "./types.js";

// Separates the HTTP call from delivery logic so tests can use a fake receiver.
export interface DeliveryTransport {
  deliver(destination: string, payload: string, headers: Record<string, string>): Promise<number>;
}

export const httpsTransport: DeliveryTransport = { deliver: sendWebhook };

function canRetry(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// Sends one claimed job and saves either the success or its next retry time.
export async function processDelivery(
  repository: Repository,
  delivery: ClaimedDelivery,
  transport: DeliveryTransport,
  now: Date = new Date()
): Promise<void> {
  const body = JSON.stringify({ id: delivery.eventId, type: delivery.eventType, data: delivery.payload });
  let status: number | null = null;
  let reason = "";
  let permanentFailure = false;

  try {
    status = await transport.deliver(delivery.url, body, {
      "x-relayforge-event-id": delivery.eventId,
      "x-relayforge-attempt": String(delivery.attempts),
      "x-relayforge-signature": signWebhook(body, delivery.signingSecret)
    });
    if (status >= 200 && status < 300) {
      await repository.markDelivered(delivery.id, status, delivery.attempts);
      return;
    }
    reason = `Destination returned HTTP ${status}`;
    // Retrying a permanent 4xx (or a redirect) just repeats the same bad request.
    permanentFailure = !canRetry(status);
  } catch (error: unknown) {
    reason = error instanceof Error ? error.message : "Delivery failed";
    permanentFailure = error instanceof UnsafeDestinationError;
  }

  if (permanentFailure || delivery.attempts >= MAX_ATTEMPTS) {
    await repository.markFailed(delivery.id, status, reason, delivery.attempts);
  } else {
    await repository.markRetrying(delivery.id, status, reason, retryAtFrom(delivery.attempts, now), delivery.attempts);
  }
}

// Small batches keep one worker from monopolizing the queue.
export async function processBatch(
  repository: Repository,
  transport: DeliveryTransport = httpsTransport,
  limit = 20
): Promise<number> {
  const deliveries = await repository.claimDueDeliveries(limit);
  for (const delivery of deliveries) {
    await processDelivery(repository, delivery, transport);
  }
  return deliveries.length;
}
