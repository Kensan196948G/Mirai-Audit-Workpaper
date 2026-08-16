// セッション管理（Cookie + DB 保存）

import type { Db } from "./db/db.ts";
import { newSessionToken } from "./auth.ts";
import { nowIso } from "./ids.ts";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

export interface Session {
  token: string;
  user_id: string;
  expires_at: string;
}

export async function createSession(db: Db, userId: string): Promise<Session> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db
    .prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .bind(token, userId, expiresAt, nowIso())
    .run();
  return { token, user_id: userId, expires_at: expiresAt };
}

export async function getSession(db: Db, token: string): Promise<Session | null> {
  const row = await db
    .prepare(`SELECT token, user_id, expires_at FROM sessions WHERE token = ?`)
    .bind(token)
    .first<Session>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
}

/** 期限切れセッションの掃除（ログイン時に実施） */
export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso()).run();
}

/** セッションCookie。secure=true で Secure 属性を付与（HTTPS環境のみ） */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function readSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  return m ? m[1]! : null;
}
