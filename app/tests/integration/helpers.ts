// テスト用 in-memory SQLite（node:sqlite）で Db インターフェースを実装
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Db, PreparedStatement } from "../../src/db/db.ts";
import { hashPassword } from "../../src/auth.ts";
import { newId, nowIso } from "../../src/ids.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface TestUserSeed {
  email: string;
  name: string;
  role: string;
  department: string;
  password: string;
}

class SyncStmt implements PreparedStatement {
  private params: unknown[] = [];

  private stmt: any;

  constructor(stmt: any) {
    this.stmt = stmt;
  }

  bind(...values: unknown[]): PreparedStatement {
    this.params = values.map((v) => (v === undefined ? null : v));
    return this;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...this.params) as any;
    return (row ?? null) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const rows = this.stmt.all(...this.params) as unknown[];
    return { results: rows as T[] };
  }
  async run(): Promise<{ meta: { changes?: number; last_row_id?: number } }> {
    const info = this.stmt.run(...this.params) as any;
    return { meta: { changes: info.changes, last_row_id: info.lastInsertRowid as number } };
  }
}

export class SyncDb implements Db {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string): PreparedStatement {
    return new SyncStmt(this.db.prepare(sql));
  }
  async exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return null;
  }
}

/** スキーマ適用（migrations/0001_initial.sql をそのまま流用） */
export function applySchema(db: DatabaseSync): void {
  const sql = readFileSync(join(here, "..", "..", "migrations", "0001_initial.sql"), "utf-8");
  db.exec(sql);
}

/** テスト用ユーザーをシード */
export async function seedUsers(db: DatabaseSync, users: TestUserSeed[]): Promise<void> {
  const ts = nowIso();
  const stmt = db.prepare(
    `INSERT INTO users (id, email, name, role, department, active, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
  );
  for (const u of users) {
    const hash = await hashPassword(u.password);
    stmt.run(newId("usr"), u.email, u.name, u.role, u.department, hash, ts, ts);
  }
}

/** テスト用に完全なDBを構築 */
export async function createTestDb(users: TestUserSeed[]): Promise<Db> {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  await seedUsers(db, users);
  return new SyncDb(db);
}
