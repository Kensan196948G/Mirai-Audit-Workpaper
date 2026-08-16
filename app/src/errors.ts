// アプリケーションエラー（詳細仕様設計書 6.2 エラー形式に準拠）

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;

  constructor(status: number, code: string, message: string, correlationId?: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId ?? `c-${Date.now().toString(36)}`;
  }
}

export const err = {
  badRequest: (msg: string) => new AppError(400, "BAD_REQUEST", msg),
  unauthorized: (msg = "認証が必要です") => new AppError(401, "UNAUTHORIZED", msg),
  forbidden: (msg = "権限がありません") => new AppError(403, "FORBIDDEN", msg),
  notFound: (msg = "対象が見つかりません") => new AppError(404, "NOT_FOUND", msg),
  conflict: (msg: string) => new AppError(409, "VERSION_CONFLICT", msg),
  tooManyRequests: (msg = "リクエストが多すぎます") => new AppError(429, "RATE_LIMITED", msg),
  internal: (msg = "内部エラーが発生しました") => new AppError(500, "INTERNAL", msg),
};

/** エラー応答ボディ（詳細仕様設計書 6.2） */
export function errorBody(e: AppError) {
  return {
    error: {
      code: e.code,
      message: e.message,
      correlation_id: e.correlationId,
    },
  };
}
