-- 監査業務・証跡管理 — D1 スキーマ (migration 0001)
-- 要件定義書 MAW-RD-001 のデータ設計（詳細仕様設計書 5.2）に基づく

-- 利用者
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('auditor','audit_committee','general_affairs','auditee','admin')),
  department TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 年度監査計画
CREATE TABLE IF NOT EXISTS audit_plans (
  id TEXT PRIMARY KEY,
  fiscal_year TEXT NOT NULL,
  title TEXT NOT NULL,
  policy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_fiscal ON audit_plans(fiscal_year);

-- 個別監査案件
CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  engagement_no TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES audit_plans(id),
  title TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'C2' CHECK (classification IN ('C1','C2','C3')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','in_progress','review','reported','closed')),
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagements_plan ON engagements(plan_id);
CREATE INDEX IF NOT EXISTS idx_engagements_status ON engagements(status);

-- 案件メンバー（監査役・レビュー担当）
CREATE TABLE IF NOT EXISTS engagement_members (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role_in_engagement TEXT NOT NULL DEFAULT 'member' CHECK (role_in_engagement IN ('auditor','reviewer','assistant')),
  conflict_flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (engagement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON engagement_members(user_id);

-- 証憑依頼
CREATE TABLE IF NOT EXISTS evidence_requests (
  id TEXT PRIMARY KEY,
  request_no TEXT NOT NULL UNIQUE,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  recipient_department TEXT NOT NULL,
  item TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','sent','partial','received','returned','closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_engagement ON evidence_requests(engagement_id);

-- 証憑提出（サブミッション）
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES evidence_requests(id),
  submitter_id TEXT NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted','returned')),
  submitted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_request ON submissions(request_id);

-- 監査調書
CREATE TABLE IF NOT EXISTS workpapers (
  id TEXT PRIMARY KEY,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  code TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  reviewer_id TEXT REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','review_requested','returned','approved','final')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (engagement_id, code)
);
CREATE INDEX IF NOT EXISTS idx_workpapers_engagement ON workpapers(engagement_id);

-- 調書バージョン（版管理・正本）
CREATE TABLE IF NOT EXISTS workpaper_versions (
  id TEXT PRIMARY KEY,
  workpaper_id TEXT NOT NULL REFERENCES workpapers(id),
  version_no INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  conclusion TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT '',
  is_final INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (workpaper_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions_workpaper ON workpaper_versions(workpaper_id);

-- 発見事項・指摘
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  finding_no TEXT NOT NULL UNIQUE,
  engagement_id TEXT NOT NULL REFERENCES engagements(id),
  fact TEXT NOT NULL,
  criterion TEXT NOT NULL DEFAULT '',
  cause TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('high','medium','low')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','fact_check','confirmed','remediated','rechecked','completed','reissued')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_findings_engagement ON findings(engagement_id);

-- 被監査部門の回答・異議
CREATE TABLE IF NOT EXISTS finding_responses (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  respondent_id TEXT NOT NULL REFERENCES users(id),
  response TEXT NOT NULL DEFAULT '',
  disagreement TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_responses_finding ON finding_responses(finding_id);

-- 是正計画・フォローアップ
CREATE TABLE IF NOT EXISTS remediations (
  id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES findings(id),
  action TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  due_at TEXT,
  evidence_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','in_progress','submitted','verified','completed')),
  verified_by TEXT REFERENCES users(id),
  verified_at TEXT,
  verified_result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remediations_finding ON remediations(finding_id);

-- セッション
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 監査ログ（追記専用）
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'success',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_events_object ON audit_events(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_time ON audit_events(occurred_at);
