import { sqlite } from "./client.js";

type TableColumn = {
  name: string;
};

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = sqlite
    .prepare(`PRAGMA table_info(${table})`)
    .all() as TableColumn[];

  if (columns.some((entry) => entry.name === column)) {
    return;
  }

  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function bootstrapDatabase(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      extracted_text TEXT,
      candidates_json TEXT NOT NULL DEFAULT '[]',
      recommendations_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      analysis_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id TEXT PRIMARY KEY,
      body INTEGER NOT NULL,
      acidity INTEGER NOT NULL,
      tannin INTEGER NOT NULL,
      sweetness INTEGER NOT NULL,
      weight_body INTEGER NOT NULL,
      weight_acidity INTEGER NOT NULL,
      weight_tannin INTEGER NOT NULL,
      weight_sweetness INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

  `);

  ensureColumn("analyses", "cancellation_requested", "INTEGER NOT NULL DEFAULT 0");
}
