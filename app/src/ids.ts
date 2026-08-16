// ID・採番ユーティリティ（詳細仕様設計書 5.2: AUD-YYYY-NNNN 等）

/** 汎用ID: 接頭辞 + 時刻 + 乱数 */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}${rand}`;
}

/** 案件番号: AUD-YYYY-NNNN（年度+4桁連番） */
export function engagementNo(fiscalYear: string, seq: number): string {
  return `AUD-${fiscalYear}-${String(seq).padStart(4, "0")}`;
}

/** 依頼番号: REQ-YYYY-NNNN */
export function requestNo(fiscalYear: string, seq: number): string {
  return `REQ-${fiscalYear}-${String(seq).padStart(4, "0")}`;
}

/** 指摘番号: FND-YYYY-NNNN */
export function findingNo(fiscalYear: string, seq: number): string {
  return `FND-${fiscalYear}-${String(seq).padStart(4, "0")}`;
}

/** 年度（西暦4桁）を日時から取得 */
export function fiscalYear(date: Date = new Date()): string {
  return String(date.getFullYear());
}

/** UTC ISO 8601 時刻 */
export function nowIso(date: Date = new Date()): string {
  return date.toISOString();
}
