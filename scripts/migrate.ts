import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

// Applies the checked-in schema during local setup or the Compose startup.
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const sql = await readFile(resolve(process.cwd(), "sql/001_init.sql"), "utf8");
    await pool.query(sql);
    process.stdout.write("Database migration applied successfully.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Migration failed: ${String(error)}\n`);
  process.exitCode = 1;
});
