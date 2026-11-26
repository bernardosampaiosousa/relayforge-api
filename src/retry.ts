export const MAX_ATTEMPTS = 5;

// 30s, 2m, 8m, 30m: cap the delay to spare offline receivers.
export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Invalid attempt number");
  return Math.min(30_000 * 4 ** (attempt - 1), 1_800_000);
}

// Compute the next retry timestamp from the current attempt.
export function retryAtFrom(attempt: number, now: Date): Date {
  return new Date(now.getTime() + retryDelayMs(attempt));
}
