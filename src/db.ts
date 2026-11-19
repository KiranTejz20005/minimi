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
  return db;
}
