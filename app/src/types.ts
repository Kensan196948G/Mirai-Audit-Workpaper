// 共通型定義（要件定義書 MAW-RD-001 / 詳細仕様設計書 5.2 に基づく）

export type Role = "auditor" | "audit_committee" | "general_affairs" | "auditee" | "admin";

export const ROLES: Role[] = ["auditor", "audit_committee", "general_affairs", "auditee", "admin"];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  department: string;
  active: number;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface AuditPlan {
  id: string;
  fiscal_year: string;
  title: string;
  policy: string;
  status: "draft" | "pending_approval" | "approved" | "rejected";
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

export type EngagementStatus = "draft" | "pending_approval" | "in_progress" | "review" | "reported" | "closed";

export interface Engagement {
  id: string;
  engagement_no: string;
  plan_id: string;
  title: string;
  scope: string;
  criteria: string;
  department: string;
  classification: "C1" | "C2" | "C3";
  status: EngagementStatus;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

export interface EngagementMember {
  id: string;
  engagement_id: string;
  user_id: string;
  role_in_engagement: "auditor" | "reviewer" | "assistant";
  conflict_flagged: number;
  created_at: string;
}

export type RequestStatus = "draft" | "pending_approval" | "sent" | "partial" | "received" | "returned" | "closed";

export interface EvidenceRequest {
  id: string;
  request_no: string;
  engagement_id: string;
  recipient_department: string;
  item: string;
  purpose: string;
  due_at: string | null;
  status: RequestStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface Submission {
  id: string;
  request_id: string;
  submitter_id: string;
  file_name: string;
  content_hash: string;
  note: string;
  status: "submitted" | "accepted" | "returned";
  submitted_at: string;
}

export type WorkpaperStatus = "draft" | "review_requested" | "returned" | "approved" | "final";

export interface Workpaper {
  id: string;
  engagement_id: string;
  code: string;
  title: string;
  owner_id: string;
  reviewer_id: string | null;
  status: WorkpaperStatus;
  created_at: string;
  updated_at: string;
}

export interface WorkpaperVersion {
  id: string;
  workpaper_id: string;
  version_no: number;
  body: string;
  conclusion: string;
  content_hash: string;
  is_final: number;
  created_by: string;
  created_at: string;
}

export type FindingStatus = "draft" | "fact_check" | "confirmed" | "remediated" | "rechecked" | "completed" | "reissued";

export interface Finding {
  id: string;
  finding_no: string;
  engagement_id: string;
  fact: string;
  criterion: string;
  cause: string;
  impact: string;
  severity: "high" | "medium" | "low";
  status: FindingStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface FindingResponse {
  id: string;
  finding_id: string;
  respondent_id: string;
  response: string;
  disagreement: string;
  created_at: string;
}

export type RemediationStatus = "planned" | "in_progress" | "submitted" | "verified" | "completed";

export interface Remediation {
  id: string;
  finding_id: string;
  action: string;
  owner_id: string;
  due_at: string | null;
  evidence_note: string;
  status: RemediationStatus;
  verified_by: string | null;
  verified_at: string | null;
  verified_result: string;
  created_at: string;
  updated_at: string;
}

export interface AuditEvent {
  id: string;
  occurred_at: string;
  actor_id: string | null;
  action: string;
  object_type: string;
  object_id: string;
  result: string;
  detail: string;
  ip: string;
}

export interface TaskItem {
  type: "plan" | "engagement" | "request" | "workpaper" | "finding" | "remediation";
  id: string;
  title: string;
  status: string;
  due_at: string | null;
}

// 案件可否判定用のコンテキスト
export interface UserContext {
  user: User;
  engagementAccess: Record<string, boolean>; // engagement_id -> アクセス可
}
