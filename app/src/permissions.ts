// 権限・RBAC（要件定義書 3.1 権限マトリクス / 詳細仕様設計書 7.1 認可判定）

import type { Role } from "./types.ts";

/** 操作種別 */
export type Permission =
  | "plan:create" | "plan:update" | "plan:approve" | "plan:view"
  | "engagement:create" | "engagement:update" | "engagement:status" | "engagement:view"
  | "request:create" | "request:send" | "request:view" | "request:submit"
  | "workpaper:create" | "workpaper:review" | "workpaper:approve"
  | "finding:create" | "finding:confirm" | "finding:respond"
  | "remediation:create" | "remediation:verify"
  | "auditlog:view" | "admin:manage";

/**
 * ロール×操作の許可マトリクス（要件定義書 3.1 をコード化）
 * 監査役: 作成・更新・レビュー・確定。監査役会: 承認・審議。
 * 総務部: 日程・送付・期限補助。被監査部門: 自部門分の回答・提出。
 * システム管理者: 設定のみ（業務内容閲覧は原則不可）。
 */
const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  auditor: new Set([
    "plan:create", "plan:update", "plan:view",
    "engagement:create", "engagement:update", "engagement:status", "engagement:view",
    "request:create", "request:send", "request:view",
    "workpaper:create", "workpaper:review",
    "finding:create", "finding:confirm",
    "remediation:create", "remediation:verify",
    "auditlog:view",
  ]),
  audit_committee: new Set([
    "plan:approve", "plan:view", "engagement:view", "request:view",
    "workpaper:review", "workpaper:approve", "finding:confirm", "auditlog:view",
  ]),
  general_affairs: new Set([
    "plan:view", "engagement:view", "request:create", "request:send",
    "request:view", "engagement:update",
  ]),
  auditee: new Set([
    "request:view", "request:submit", "finding:respond", "remediation:create",
  ]),
  admin: new Set([
    "admin:manage", "auditlog:view",
  ]),
};

export function hasPermission(role: Role, perm: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(perm) ?? false;
}

/** 指定ロールが許可を持つ操作一覧（デバッグ・権限棚卸し用） */
export function permissionsFor(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])].sort();
}

/**
 * 案件アクセス判定（詳細仕様設計書 7.1）
 * - 監査役・監査役会: 案件メンバーまたは明示共有
 * - 被監査部門: 依頼先部門が自部門の案件のみ
 * - 管理者: 業務内容閲覧不可（技術管理のみ）
 * - 総務部: 必要時のみ
 */
export function canViewEngagement(
  role: Role,
  userDepartment: string,
  engagementDepartment: string,
  isMember: boolean
): boolean {
  switch (role) {
    case "auditor":
    case "audit_committee":
      return isMember;
    case "general_affairs":
      return isMember; // 事務局が案件メンバーに含まれる場合のみ
    case "auditee":
      return userDepartment === engagementDepartment; // 自部門の案件のみ
    case "admin":
      return false; // 技術管理のみ・業務内容閲覧不可
    default:
      return false;
  }
}

/**
 * 証憑依頼の提出可否（被監査部門: 自部門への依頼のみ）
 */
export function canSubmitToRequest(
  role: Role,
  userDepartment: string,
  recipientDepartment: string
): boolean {
  if (role === "auditee") return userDepartment === recipientDepartment;
  if (role === "auditor" || role === "general_affairs") return true;
  return false;
}
