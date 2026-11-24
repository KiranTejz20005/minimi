import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  const cfg = getConfig();
  const dir = dirname(cfg.DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(cfg.DB_PATH);
  const schema = readFileSync(join(root, "schema.sql"), "utf8");
  db.exec(schema);
  migrate(db);
  return db;
}

/** Idempotent column additions for databases created before a column existed (CREATE IF NOT EXISTS can't add them). */
export function migrate(d: DatabaseSync): void {
  const addColumn = (table: string, column: string, ddl: string) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length && !cols.some((c) => c.name === column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  };
  // Extracted-document metadata for PDF/XLSX/CSV attachments: {"kind","pages","sheets":[{name,rows,cols}],"truncated"}.
  addColumn("attachments", "meta", "TEXT");
}
