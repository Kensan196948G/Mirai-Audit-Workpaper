// セキュリティ強化モジュール — CSRF対策・レート制限・セキュリティヘッダー・状態遷移
// 詳細仕様設計書 7.1/7.2 と セキュリティ・個人情報保護方針 に基づく

import { AppError } from "./errors.ts";

/** 状態変更メソッドかどうか */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF対策: 状態変更リクエストの Origin/Referer が自ホストと一致することを検証する。
 * - Cookie は SameSite=Lax のためクロスサイト POST では送信されない（一次防衛）。
 * - ブラウザは状態変更時に Origin を送るため、存在する場合は必ず検証する。
 * - Origin/Referer が無いリクエスト（APIクライアント等）は SameSite が一次防衛となるため許可する。
 */
export function assertSameOrigin(request: Request): void {
  if (!MUTATING.has(request.method.toUpperCase())) return;
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  if (!origin && !referer) return;
  const hostHeader = request.headers.get("host") ?? new URL(request.url).host;
  let sourceHost: string | null = null;
  try {
    sourceHost = new URL(origin ?? referer!).host;
  } catch {
    throw new AppError(400, "BAD_REQUEST", "不正なリクエスト元です");
  }
  if (sourceHost && sourceHost !== hostHeader) {
    throw new AppError(403, "FORBIDDEN", "不正なリクエスト元です");
  }
}

// ---------- レート制限（isolate内メモリ。本番の絶対防御は Cloudflare のレート制限・Durable Object を併用） ----------
interface Bucket {
  timestamps: number[];
}

/** スライディングウィンドウ方式の簡易レート制限（アプリインスタンス毎に分離）。超過時は 429 を投げる */
export interface RateLimiter {
  (key: string, limit: number, windowMs: number): void;
}

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, Bucket>();
  return (key: string, limit: number, windowMs: number): void => {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [] };
      buckets.set(key, bucket);
    }
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length >= limit) {
      throw new AppError(429, "RATE_LIMITED", "リクエストが多すぎます。しばらく待ってから再試行してください");
    }
    bucket.timestamps.push(now);
  };
}

// ---------- セキュリティヘッダー ----------
// SPAはインラインscript/styleを含むため、CSPは 'unsafe-inline' を含む最小構成とし、
// frame-ancestors/base-uri/form-action を制限してリスクを低減する。
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// ---------- 状態遷移マトリクス（詳細仕様設計書 5.1 状態遷移図） ----------

/** 年度監査計画: draft→承認申請→承認/却下。却下は差戻し編集可 */
export const PLAN_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "rejected"],
  approved: [],
  rejected: ["draft", "pending_approval"],
};

/** 個別監査案件: 段階的に進行し、closed は終端 */
export const ENGAGEMENT_TRANSITIONS: Record<string, string[]> = {
  draft: ["pending_approval", "in_progress", "closed"],
  pending_approval: ["in_progress", "review", "closed"],
  in_progress: ["review", "reported", "closed"],
  review: ["reported", "in_progress", "closed"],
  reported: ["closed", "review"],
  closed: ["in_progress"], // 再開（監査役操作）
};

/** 証憑依頼: 送付→一部受領→受領→締切。差戻しは再提出可能 */
export const REQUEST_TRANSITIONS: Record<string, string[]> = {
  draft: ["sent", "closed"],
  sent: ["partial", "returned", "closed"],
  partial: ["received", "returned", "closed"],
  received: ["closed", "returned"],
  returned: ["sent", "partial", "closed"],
  closed: [],
};

/** 監査調書: レビュー依頼→確定 または 差戻し */
export const WORKPAPER_TRANSITIONS: Record<string, string[]> = {
  draft: ["review_requested", "returned"],
  review_requested: ["final", "returned"],
  returned: ["review_requested", "final"],
  approved: [],
  final: [],
};

/** 状態遷移を検証し、不正なら AppError(409) を投げる */
export function assertTransition(table: Record<string, string[]>, from: string, to: string, subject: string): void {
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new AppError(409, "INVALID_TRANSITION", `${subject}を「${from}」から「${to}」へ変更できません`);
  }
}
