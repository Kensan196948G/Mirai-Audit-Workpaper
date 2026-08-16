// ユニットテスト — 監査ログ検索の limit クランプ（負値・0・過大値で無制限/全件取得にならない）

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { queryAuditEvents } from "../../src/audit.ts";
import type { Db, PreparedStatement } from "../../src/db/db.ts";

class CapturingStmt implements PreparedStatement {
  sql = "";
  params: unknown[] = [];
  bind(...values: unknown[]): PreparedStatement {
    this.params = values;
    return this;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: [] };
  }
  async run(): Promise<{ meta: { changes?: number; last_row_id?: number } }> {
    return { meta: {} };
  }
}

class CapturingDb implements Db {
  stmt: CapturingStmt | null = null;
  prepare(sql: string): PreparedStatement {
    this.stmt = new CapturingStmt();
    this.stmt.sql = sql;
    return this.stmt;
  }
  async exec(sql: string): Promise<unknown> {
    return sql;
  }
}

describe("unit: queryAuditEvents limit clamp", () => {
  test("limit=-1 is clamped to 1", async () => {
    const db = new CapturingDb();
    await queryAuditEvents(db, { limit: -1 });
    assert.match(db.stmt!.sql, /LIMIT 1$/);
  });

  test("limit=0 is clamped to 1", async () => {
    const db = new CapturingDb();
    await queryAuditEvents(db, { limit: 0 });
    assert.match(db.stmt!.sql, /LIMIT 1$/);
  });

  test("limit=1000 is clamped to 500", async () => {
    const db = new CapturingDb();
    await queryAuditEvents(db, { limit: 1000 });
    assert.match(db.stmt!.sql, /LIMIT 500$/);
  });

  test("default limit is 100", async () => {
    const db = new CapturingDb();
    await queryAuditEvents(db, {});
    assert.match(db.stmt!.sql, /LIMIT 100$/);
  });
});
