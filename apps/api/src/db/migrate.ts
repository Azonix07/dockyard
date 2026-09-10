import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  await client.query(sql);
  await client.end();
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
