// 監査ログ（追記専用・改変防止）— 詳細仕様設計書 7.3 / FR-13

import type { Db } from "./db/db.ts";
import { newId, nowIso } from "./ids.ts";

export interface AuditEventInput {
  actorId: string | null;
  action: string;
  objectType: string;
  objectId: string;
  result?: string;
  detail?: string;
  ip?: string;
}

/** 監査イベントを追記（UPDATE/DELETE のAPIは提供しない＝追記専用） */
export async function writeAuditEvent(db: Db, input: AuditEventInput): Promise<void> {
  const id = newId("evt");
  const occurredAt = nowIso();
  await db
    .prepare(
      `INSERT INTO audit_events (id, occurred_at, actor_id, action, object_type, object_id, result, detail, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      occurredAt,
      input.actorId,
      input.action,
      input.objectType,
      input.objectId,
      input.result ?? "success",
      input.detail ?? "",
      input.ip ?? ""
    )
    .run();
}

/** 監査イベント検索（権限者は検索可、一般管理者は削除不可） */
export async function queryAuditEvents(
  db: Db,
  opts: { limit?: number; actorId?: string; objectType?: string; objectId?: string; action?: string }
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.actorId) {
    where.push("actor_id = ?");
    params.push(opts.actorId);
  }
  if (opts.objectType) {
    where.push("object_type = ?");
    params.push(opts.objectType);
  }
  if (opts.objectId) {
    where.push("object_id = ?");
    params.push(opts.objectId);
  }
  if (opts.action) {
    where.push("action = ?");
    params.push(opts.action);
  }
  // limit は 1〜500 にクランプ（負値や 0 で無制限・全件取得にならないようにする）
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const sql =
    `SELECT id, occurred_at, actor_id, action, object_type, object_id, result, detail, ip
     FROM audit_events` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY occurred_at DESC LIMIT ${limit}`;
  const rows = await db.prepare(sql).bind(...params).all();
  return rows.results;
}
