const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("./config/database");

async function migrate() {
  const directory = path.join(__dirname, "..", "migrations");
  // const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const allFiles = (await fs.readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const requestedFile = process.argv[2];

  if (requestedFile && !allFiles.includes(requestedFile)) {
    throw new Error(`Migration file not found: ${requestedFile}`);
  }

  const files = requestedFile ? [requestedFile] : allFiles;

  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (existing.rowCount) continue;
      const sql = await fs.readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed");
  process.exitCode = 1;
});
