import pg from "pg";
import { createApp } from "./app.js";
import { requiredDatabaseUrl, requiredJwtSecret } from "./config.js";
import { PgStore } from "./pg-store.js";

// The HTTP process owns its database pool and closes it on shutdown.
async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: requiredDatabaseUrl(), max: 10 });
  const app = await createApp({ repository: new PgStore(pool), jwtSecret: requiredJwtSecret(), logger: true });

  // Releases connections when the process stops instead of leaving them open.
  const shutdown = async (): Promise<void> => {
    await app.close();
    await pool.end();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  const port = Number(process.env.PORT ?? "3000");
  await app.listen({ host: "0.0.0.0", port });
}

main().catch(error => {
  process.stderr.write(`Startup failed: ${String(error)}\n`);
  process.exitCode = 1;
});
