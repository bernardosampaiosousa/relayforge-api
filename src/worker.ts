import pg from "pg";
import { requiredDatabaseUrl } from "./config.js";
import { processBatch } from "./dispatcher.js";
import { PgStore } from "./pg-store.js";

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: requiredDatabaseUrl(), max: 5 });
  const store = new PgStore(pool);
  const pollMs = Math.max(1000, Number(process.env.WORKER_POLL_MS ?? "3000") || 3000);
  let running = true;
  process.once("SIGINT", () => { running = false; });
  process.once("SIGTERM", () => { running = false; });

  process.stdout.write(`RelayForge worker started (poll every ${pollMs}ms).\n`);
  try {
    while (running) {
      try {
        const count = await processBatch(store);
        if (count > 0) process.stdout.write(`Processed ${count} deliveries.\n`);
      } catch (error: unknown) {
        process.stderr.write(`Worker error: ${String(error)}\n`);
      }
      if (running) await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`Startup failed: ${String(error)}\n`);
  process.exitCode = 1;
});
