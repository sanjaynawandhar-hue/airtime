/**
 * Apply src/lib/db/schema.sql to the database in DATABASE_URL.
 *
 * Run:  npm run db:push
 *
 * The schema is written with IF NOT EXISTS throughout, so this is safe to run
 * repeatedly. It creates tables only — it never drops or alters one, because a
 * migration that silently destroys reader reviews is not a migration.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set.\n" +
        "Create a Neon project at https://console.neon.tech, copy the POOLED\n" +
        "connection string, and put it in .env.local as DATABASE_URL.",
    );
    process.exit(1);
  }

  const sql = neon(url);
  const schemaPath = join(process.cwd(), "src", "lib", "db", "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");

  // Split on semicolons at end of line; the schema contains no function bodies
  // or dollar-quoted strings, so this is sufficient and keeps the script small.
  const statements = schema
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));

  console.log(`Applying ${statements.length} statements…`);

  for (const statement of statements) {
    const label = statement.split("\n")[0].slice(0, 72);
    try {
      await sql.query(statement);
      console.log(`  ok   ${label}`);
    } catch (error) {
      console.error(`  FAIL ${label}`);
      console.error(`       ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  const tables = (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `) as { table_name: string }[];

  console.log(`\nTables now present: ${tables.map((t) => t.table_name).join(", ")}`);
}

main().catch((error) => {
  console.error("db:push failed:", error);
  process.exit(1);
});
