export const MAX_ATTEMPTS = 5;

/** Bounded exponential backoff: 30s, 2m, 8m, 30m. */
export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("Invalid attempt number");
  return Math.min(30_000 * 4 ** (attempt - 1), 1_800_000);
}

export function retryAtFrom(attempt: number, now: Date): Date {
  return new Date(now.getTime() + retryDelayMs(attempt));
}
