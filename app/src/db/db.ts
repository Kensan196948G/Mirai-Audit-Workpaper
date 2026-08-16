// DB 抽象層 — D1 とローカルSQLite（テスト用）の両方で動く共通インターフェース

export interface Db {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): Promise<unknown>;
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number } }>;
}

/** D1 バインディングを Db インターフェースへ適合 */
export class D1Db implements Db {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

  prepare(sql: string): PreparedStatement {
    return new D1Stmt(this.d1.prepare(sql));
  }
  async exec(sql: string): Promise<unknown> {
    return this.d1.exec(sql);
  }
}

class D1Stmt implements PreparedStatement {
  private stmt: D1PreparedStatement;

  constructor(stmt: D1PreparedStatement) {
    this.stmt = stmt;
  }

  bind(...values: unknown[]): PreparedStatement {
    this.stmt = this.stmt.bind(...values);
    return this;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (await this.stmt.first()) as T | null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const r = await this.stmt.all();
    return { results: r.results as T[] };
  }
  async run(): Promise<{ meta: { changes?: number; last_row_id?: number } }> {
    const r = await this.stmt.run();
    return { meta: { changes: r.meta.changes, last_row_id: r.meta.last_row_id } };
  }
}

/** 型付きラッパー: 1件取得 */
export async function getRow<T>(db: Db, sql: string, ...params: unknown[]): Promise<T | null> {
  return db.prepare(sql).bind(...params).first<T>();
}

/** 型付きラッパー: 複数取得 */
export async function getRows<T>(db: Db, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results;
}

/** 型付きラッパー: 実行 */
export async function run(db: Db, sql: string, ...params: unknown[]): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}
