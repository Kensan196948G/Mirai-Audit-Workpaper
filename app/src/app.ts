// Hono アプリ本体 — ルーティング・認証ミドルウェア・エラーハンドリング

import { Hono } from "hono";

import type { Db } from "./db/db.ts";
import { AppError, errorBody } from "./errors.ts";
import { getSession, readSessionToken, createSession, deleteSession, clearSessionCookie, purgeExpiredSessions, sessionCookie } from "./session.ts";
import { verifyPassword, hashPassword, sha256Hex } from "./auth.ts";
import { getRow, getRows, run } from "./db/db.ts";
import { hasPermission, canViewEngagement, canSubmitToRequest, type Permission } from "./permissions.ts";
import { writeAuditEvent, queryAuditEvents } from "./audit.ts";
import { newId, nowIso, engagementNo, requestNo, findingNo, fiscalYear } from "./ids.ts";
import type { User, Role } from "./types.ts";
import { EMBEDDED_INDEX_HTML } from "./embedded-assets.ts";
import {
  assertSameOrigin,
  createRateLimiter,
  SECURITY_HEADERS,
  assertTransition,
  PLAN_TRANSITIONS,
  ENGAGEMENT_TRANSITIONS,
  REQUEST_TRANSITIONS,
  WORKPAPER_TRANSITIONS,
  FINDING_TRANSITIONS,
} from "./security.ts";

export interface AppDeps {
  db: Db;
  environment: string;
  getClientIp?: (req: Request) => string;
  /** preview/mvp/local の初期パスワード（本番では未使用）。未指定時は既定のテスト用パスワード */
  bootstrapPassword?: string;
}

export interface AppContext {
  db: Db;
  environment: string;
  user: User | null;
  ip: string;
}

const CTX_KEY = "appCtx";

// ---------- 軽量入力検証（zod非依存・バンドル縮小） ----------
type Rule =
  | { type: "string"; required?: boolean; min?: number; pattern?: RegExp; default?: string }
  | { type: "email"; required?: boolean }
  | { type: "enum"; values: string[]; default?: string; required?: boolean }
  | { type: "string-or-null"; required?: boolean };

type Schema = Record<string, Rule>;

function makeValidator(schema: Schema) {
  return async (c: any, next: () => Promise<void>) => {
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const errors: string[] = [];
    const cleaned: Record<string, unknown> = {};
    for (const [key, rule] of Object.entries(schema)) {
      const raw = body[key];
      const present = raw !== undefined && raw !== null && raw !== "";
      if (!present) {
        if ("default" in rule && rule.default !== undefined) {
          cleaned[key] = rule.default;
          continue;
        }
        if (rule.required) {
          errors.push(`${key}は必須です`);
        } else {
          cleaned[key] = undefined;
        }
        continue;
      }
      if (rule.type === "email") {
        if (typeof raw !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
          errors.push(`${key}の形式が不正です`);
          continue;
        }
        cleaned[key] = raw;
      } else if (rule.type === "enum") {
        if (!rule.values.includes(raw as string)) {
          errors.push(`${key}の値が不正です`);
          continue;
        }
        cleaned[key] = raw;
      } else if (rule.type === "string-or-null") {
        cleaned[key] = raw === null ? null : String(raw);
      } else {
        // string
        const s = String(raw);
        if (rule.min !== undefined && s.length < rule.min) {
          errors.push(`${key}は${rule.min}文字以上必要です`);
          continue;
        }
        if (rule.pattern && !rule.pattern.test(s)) {
          errors.push(`${key}の形式が不正です`);
          continue;
        }
        cleaned[key] = s;
      }
    }
    if (errors.length) {
      throw new AppError(400, "BAD_REQUEST", errors.join("、"));
    }
    c.set("validBody", cleaned);
    await next();
  };
}

// 各スキーマ定義（zodスキーマの置き換え）
const loginSchema: Schema = {
  email: { type: "email", required: true },
  password: { type: "string", required: true, min: 8 },
};
const planCreateSchema: Schema = {
  fiscal_year: { type: "string", required: true, pattern: /^\d{4}$/ },
  title: { type: "string", required: true, min: 1 },
  policy: { type: "string", default: "" },
};
const engagementCreateSchema: Schema = {
  plan_id: { type: "string", required: true, min: 1 },
  title: { type: "string", required: true, min: 1 },
  scope: { type: "string", default: "" },
  criteria: { type: "string", default: "" },
  department: { type: "string", required: true, min: 1 },
  classification: { type: "enum", values: ["C1", "C2", "C3"], default: "C2" },
};
const engagementUpdateSchema: Schema = {
  title: { type: "string", min: 1 },
  scope: { type: "string" },
  criteria: { type: "string" },
  department: { type: "string", min: 1 },
  classification: { type: "enum", values: ["C1", "C2", "C3"] },
};
const statusSchema: Schema = { status: { type: "string", required: true, min: 1 } };
const requestCreateSchema: Schema = {
  recipient_department: { type: "string", required: true, min: 1 },
  item: { type: "string", required: true, min: 1 },
  purpose: { type: "string", default: "" },
  due_at: { type: "string-or-null" },
};
const submissionSchema: Schema = {
  file_name: { type: "string", required: true, min: 1 },
  content_hash: { type: "string", required: true, min: 1 },
  note: { type: "string", default: "" },
};
const workpaperSchema: Schema = {
  code: { type: "string", required: true, min: 1 },
  title: { type: "string", required: true, min: 1 },
  body: { type: "string", default: "" },
  conclusion: { type: "string", default: "" },
  reviewer_id: { type: "string-or-null" },
};
const workpaperUpdateSchema: Schema = {
  body: { type: "string" },
  conclusion: { type: "string" },
  reviewer_id: { type: "string-or-null" },
};
const findingSchema: Schema = {
  fact: { type: "string", required: true, min: 1 },
  criterion: { type: "string", default: "" },
  cause: { type: "string", default: "" },
  impact: { type: "string", default: "" },
  severity: { type: "enum", values: ["high", "medium", "low"], default: "medium" },
};
const findingResponseSchema: Schema = {
  response: { type: "string", required: true, min: 1 },
  disagreement: { type: "string", default: "" },
};
const findingConfirmSchema: Schema = {
  severity: { type: "enum", values: ["high", "medium", "low"] },
};
const remediationSchema: Schema = {
  action: { type: "string", required: true, min: 1 },
  owner_id: { type: "string", required: true, min: 1 },
  due_at: { type: "string-or-null" },
};
const remediationVerifySchema: Schema = {
  result: { type: "string", required: true, min: 1 },
  evidence_note: { type: "string", default: "" },
};

function bodyOf(c: any): Record<string, any> {
  return (c.get("validBody") ?? {}) as Record<string, any>;
}

// ---------- ミドルウェア ----------
async function loadUser(c: any): Promise<User | null> {
  const token = readSessionToken(c.req.header("cookie") ?? null);
  if (!token) return null;
  const session = await getSession(c.get(CTX_KEY).db, token);
  if (!session) return null;
  const user = await getRow<User>(
    c.get(CTX_KEY).db,
    `SELECT id, email, name, role, department, active, password_hash, created_at, updated_at FROM users WHERE id = ? AND active = 1`,
    session.user_id
  );
  return user;
}

/** 認証必須 */
function requireAuth() {
  return async (c: any, next: () => Promise<void>) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    if (!ctx.user) {
      throw new AppError(401, "UNAUTHORIZED", "ログインが必要です");
    }
    await next();
  };
}

/** 権限チェック */
function requirePerm(perm: Permission) {
  return async (c: any, next: () => Promise<void>) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    if (!ctx.user) throw new AppError(401, "UNAUTHORIZED", "ログインが必要です");
    if (!hasPermission(ctx.user.role, perm)) {
      await writeAuditEvent(ctx.db, {
        actorId: ctx.user.id,
        action: `permission_denied:${perm}`,
        objectType: "permission",
        objectId: perm,
        result: "denied",
        ip: ctx.ip,
      });
      throw new AppError(403, "FORBIDDEN", "この操作の権限がありません");
    }
    await next();
  };
}

// ---------- ヘルパー ----------
async function loadEngagement(ctx: AppContext, engagementId: string) {
  const e = await getRow<any>(
    ctx.db,
    `SELECT id, engagement_no, plan_id, title, scope, criteria, department, classification, status, owner_id, created_at, updated_at FROM engagements WHERE id = ?`,
    engagementId
  );
  if (!e) throw new AppError(404, "NOT_FOUND", "案件が見つかりません");
  return e;
}

async function checkEngagementAccess(ctx: AppContext, engagement: any): Promise<void> {
  if (!ctx.user) throw new AppError(401, "UNAUTHORIZED", "ログインが必要です");
  const isMember = await getRow<any>(
    ctx.db,
    `SELECT id FROM engagement_members WHERE engagement_id = ? AND user_id = ?`,
    engagement.id,
    ctx.user.id
  );
  const allowed = canViewEngagement(
    ctx.user.role,
    ctx.user.department,
    engagement.department,
    !!isMember
  );
  if (!allowed) {
    await writeAuditEvent(ctx.db, {
      actorId: ctx.user.id,
      action: "engagement_access_denied",
      objectType: "engagement",
      objectId: engagement.id,
      result: "denied",
      ip: ctx.ip,
    });
    throw new AppError(403, "FORBIDDEN", "この案件へのアクセス権がありません");
  }
}

async function addMemberIfAuditor(ctx: AppContext, engagementId: string, userId: string): Promise<void> {
  // 監査役は案件メンバーに自動追加（被監査部門・総務部は自動追加しない）
  const user = await getRow<User>(ctx.db, `SELECT id, role FROM users WHERE id = ?`, userId);
  if (user && (user.role === "auditor" || user.role === "audit_committee")) {
    await ctx.db
      .prepare(
        `INSERT OR IGNORE INTO engagement_members (id, engagement_id, user_id, role_in_engagement, conflict_flagged, created_at) VALUES (?, ?, ?, ?, 0, ?)`
      )
      .bind(newId("mem"), engagementId, userId, "auditor", nowIso())
      .run();
  }
}

// ---------- アプリ生成 ----------
export function buildApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { appCtx: AppContext } }>();
  const limiter = createRateLimiter();

  // セキュリティヘッダー（全レスポンス）＋ CSRF対策（状態変更メソッド）
  app.use("*", async (c, next) => {
    assertSameOrigin(c.req.raw);
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      c.header(k, v);
    }
  });

  app.use("*", async (c, next) => {
    const ctx: AppContext = {
      db: deps.db,
      environment: deps.environment,
      user: null,
      ip: deps.getClientIp ? deps.getClientIp(c.req.raw) : c.req.header("cf-connecting-ip") ?? "",
    };
    c.set(CTX_KEY, ctx);
    await next();
  });

  // 認証情報ロード（すべてのリクエスト）
  app.use("*", async (c, next) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    ctx.user = await loadUser(c);
    await next();
  });

  app.onError(async (err, c) => {
    if (err instanceof AppError) {
      return c.json(errorBody(err), err.status as any);
    }
    console.error("unhandled", err);
    const e = new AppError(500, "INTERNAL", "内部エラーが発生しました");
    return c.json(errorBody(e), 500);
  });

  app.notFound(async (c) => {
    const e = new AppError(404, "NOT_FOUND", "対象が見つかりません");
    return c.json(errorBody(e), 404);
  });

  // ---------- ヘルスチェック ----------
  app.get("/api/health", async (c) => {
    return c.json({ status: "ok", environment: deps.environment, time: nowIso() });
  });

  // ---------- 認証 ----------
  app.post("/api/auth/login", makeValidator(loginSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    // レート制限: IP単位 5回/分、IP+メール単位 10回/分（ブルートフォース対策）
    limiter(`login:${ctx.ip}`, 5, 60_000);
    const body = bodyOf(c);
    limiter(`login:${ctx.ip}:${String(body.email).toLowerCase()}`, 10, 60_000);
    await purgeExpiredSessions(ctx.db);
    const user = await getRow<User>(
      ctx.db,
      `SELECT id, email, name, role, department, active, password_hash, created_at, updated_at FROM users WHERE email = ?`,
      body.email.toLowerCase().trim()
    );
    if (!user || user.active !== 1) {
      await writeAuditEvent(ctx.db, { actorId: null, action: "login_failed", objectType: "auth", objectId: body.email, result: "denied", ip: ctx.ip });
      throw new AppError(401, "UNAUTHORIZED", "メールアドレスまたはパスワードが正しくありません");
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) {
      await writeAuditEvent(ctx.db, { actorId: user.id, action: "login_failed", objectType: "auth", objectId: user.id, result: "denied", ip: ctx.ip });
      throw new AppError(401, "UNAUTHORIZED", "メールアドレスまたはパスワードが正しくありません");
    }
    const session = await createSession(ctx.db, user.id);
    await writeAuditEvent(ctx.db, { actorId: user.id, action: "login", objectType: "auth", objectId: user.id, result: "success", ip: ctx.ip });
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", sessionCookie(session.token, 12 * 60 * 60, secure));
    return c.json({ id: user.id, email: user.email, name: user.name, role: user.role, department: user.department });
  });

  app.post("/api/auth/logout", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const token = readSessionToken(c.req.header("cookie") ?? null);
    if (token) await deleteSession(ctx.db, token);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "logout", objectType: "auth", objectId: ctx.user!.id, ip: ctx.ip });
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", clearSessionCookie(secure));
    return c.json({ ok: true });
  });

  app.get("/api/me", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const user = ctx.user!;
    // 自分のタスク（案件・依頼・調書・指摘）
    const memberships = await getRows<any>(
      ctx.db,
      `SELECT engagement_id FROM engagement_members WHERE user_id = ?`,
      user.id
    );
    const memberIds = memberships.map((m) => m.engagement_id);
    const tasks: any[] = [];
    if (memberIds.length) {
      const ph = memberIds.map(() => "?").join(",");
      const engagements = await getRows<any>(
        ctx.db,
        `SELECT id, engagement_no, title, status FROM engagements WHERE id IN (${ph}) ORDER BY updated_at DESC LIMIT 20`,
        ...memberIds
      );
      for (const e of engagements) {
        tasks.push({ type: "engagement", id: e.id, title: `${e.engagement_no} ${e.title}`, status: e.status, due_at: null });
      }
      // 依頼（被監査部門は自部門宛）
      const requests = await getRows<any>(
        ctx.db,
        `SELECT id, request_no, item, status, due_at FROM evidence_requests WHERE engagement_id IN (${ph}) ORDER BY created_at DESC LIMIT 20`,
        ...memberIds
      );
      for (const r of requests) tasks.push({ type: "request", id: r.id, title: r.request_no, status: r.status, due_at: r.due_at });
    }
    if (user.role === "auditee") {
      const requests = await getRows<any>(
        ctx.db,
        `SELECT id, request_no, item, status, due_at FROM evidence_requests WHERE recipient_department = ? ORDER BY created_at DESC LIMIT 20`,
        user.department
      );
      for (const r of requests) tasks.push({ type: "request", id: r.id, title: r.request_no, status: r.status, due_at: r.due_at });
    }
    // 調書（作成者・レビュー者）
    const wps = await getRows<any>(
      ctx.db,
      `SELECT id, code, title, status FROM workpapers WHERE owner_id = ? OR reviewer_id = ? ORDER BY updated_at DESC LIMIT 20`,
      user.id,
      user.id
    );
    for (const w of wps) tasks.push({ type: "workpaper", id: w.id, title: w.code, status: w.status, due_at: null });
    // 是正（責任者）
    const rems = await getRows<any>(
      ctx.db,
      `SELECT id, action, status, due_at FROM remediations WHERE owner_id = ? ORDER BY created_at DESC LIMIT 20`,
      user.id
    );
    for (const r of rems) tasks.push({ type: "remediation", id: r.id, title: r.action, status: r.status, due_at: r.due_at });
    tasks.sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"));
    return c.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, department: user.department }, tasks: tasks.slice(0, 50) });
  });

  // ---------- 年度監査計画 ----------
  app.get("/api/plans", requireAuth(), requirePerm("plan:view"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const rows = await getRows<any>(
      ctx.db,
      `SELECT id, fiscal_year, title, policy, status, version, created_by, created_at, updated_at, approved_by, approved_at FROM audit_plans ORDER BY fiscal_year DESC, created_at DESC`
    );
    return c.json({ plans: rows });
  });

  app.post("/api/plans", requireAuth(), requirePerm("plan:create"), makeValidator(planCreateSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const body = bodyOf(c);
    const id = newId("plan");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO audit_plans (id, fiscal_year, title, policy, status, version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?, ?)`,
      id, body.fiscal_year, body.title, body.policy, ctx.user!.id, ts, ts
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "plan_created", objectType: "audit_plan", objectId: id, ip: ctx.ip });
    return c.json({ id }, 201);
  });

  app.get("/api/plans/:id", requireAuth(), requirePerm("plan:view"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const plan = await getRow<any>(
      ctx.db,
      `SELECT id, fiscal_year, title, policy, status, version, created_by, created_at, updated_at, approved_by, approved_at FROM audit_plans WHERE id = ?`,
      c.req.param("id")
    );
    if (!plan) throw new AppError(404, "NOT_FOUND", "計画が見つかりません");
    const engagements = await getRows<any>(
      ctx.db,
      `SELECT id, engagement_no, title, department, status, classification FROM engagements WHERE plan_id = ? ORDER BY engagement_no`,
      plan.id
    );
    return c.json({ plan, engagements });
  });

  app.put("/api/plans/:id", requireAuth(), requirePerm("plan:update"), makeValidator(planCreateSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const plan = await getRow<any>(ctx.db, `SELECT * FROM audit_plans WHERE id = ?`, c.req.param("id"));
    if (!plan) throw new AppError(404, "NOT_FOUND", "計画が見つかりません");
    if (plan.status === "approved") throw new AppError(409, "VERSION_CONFLICT", "承認済みの計画は変更できません。新規版を作成してください");
    const body = bodyOf(c);
    await run(
      ctx.db,
      `UPDATE audit_plans SET fiscal_year = ?, title = ?, policy = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      body.fiscal_year ?? plan.fiscal_year,
      body.title ?? plan.title,
      body.policy ?? plan.policy,
      nowIso(),
      plan.id
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "plan_updated", objectType: "audit_plan", objectId: plan.id, detail: `version->${(plan.version ?? 1) + 1}`, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/plans/:id/approve", requireAuth(), requirePerm("plan:approve"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const plan = await getRow<any>(ctx.db, `SELECT * FROM audit_plans WHERE id = ?`, c.req.param("id"));
    if (!plan) throw new AppError(404, "NOT_FOUND", "計画が見つかりません");
    assertTransition(PLAN_TRANSITIONS, plan.status, "approved", "年度監査計画");
    await run(
      ctx.db,
      `UPDATE audit_plans SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
      ctx.user!.id, nowIso(), nowIso(), plan.id
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "plan_approved", objectType: "audit_plan", objectId: plan.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/plans/:id/submit", requireAuth(), requirePerm("plan:create"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const plan = await getRow<any>(ctx.db, `SELECT * FROM audit_plans WHERE id = ?`, c.req.param("id"));
    if (!plan) throw new AppError(404, "NOT_FOUND", "計画が見つかりません");
    assertTransition(PLAN_TRANSITIONS, plan.status, "pending_approval", "年度監査計画");
    await run(ctx.db, `UPDATE audit_plans SET status = 'pending_approval', updated_at = ? WHERE id = ?`, nowIso(), plan.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "plan_submitted", objectType: "audit_plan", objectId: plan.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/plans/:id/reject", requireAuth(), requirePerm("plan:approve"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const plan = await getRow<any>(ctx.db, `SELECT * FROM audit_plans WHERE id = ?`, c.req.param("id"));
    if (!plan) throw new AppError(404, "NOT_FOUND", "計画が見つかりません");
    assertTransition(PLAN_TRANSITIONS, plan.status, "rejected", "年度監査計画");
    await run(ctx.db, `UPDATE audit_plans SET status = 'rejected', updated_at = ? WHERE id = ?`, nowIso(), plan.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "plan_rejected", objectType: "audit_plan", objectId: plan.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  // ---------- 個別監査案件 ----------
  app.get("/api/engagements", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const user = ctx.user!;
    let rows: any[];
    if (user.role === "auditor" || user.role === "audit_committee") {
      const memberships = await getRows<any>(ctx.db, `SELECT engagement_id FROM engagement_members WHERE user_id = ?`, user.id);
      const ids = memberships.map((m) => m.engagement_id);
      if (ids.length === 0) {
        rows = [];
      } else {
        const ph = ids.map(() => "?").join(",");
        rows = await getRows<any>(
          ctx.db,
          `SELECT id, engagement_no, plan_id, title, scope, criteria, department, classification, status, owner_id, created_at, updated_at FROM engagements WHERE id IN (${ph}) ORDER BY engagement_no DESC LIMIT 100`,
          ...ids
        );
      }
    } else if (user.role === "auditee") {
      rows = await getRows<any>(
        ctx.db,
        `SELECT id, engagement_no, plan_id, title, scope, criteria, department, classification, status, owner_id, created_at, updated_at FROM engagements WHERE department = ? ORDER BY engagement_no DESC LIMIT 100`,
        user.department
      );
    } else if (user.role === "general_affairs") {
      const memberships = await getRows<any>(ctx.db, `SELECT engagement_id FROM engagement_members WHERE user_id = ?`, user.id);
      const ids = memberships.map((m) => m.engagement_id);
      rows = ids.length
        ? await getRows<any>(
            ctx.db,
            `SELECT id, engagement_no, plan_id, title, scope, criteria, department, classification, status, owner_id, created_at, updated_at FROM engagements WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY engagement_no DESC LIMIT 100`,
            ...ids
          )
        : [];
    } else {
      rows = []; // admin: 業務データ閲覧不可
    }
    return c.json({ engagements: rows });
  });

  app.post("/api/engagements", requireAuth(), requirePerm("engagement:create"), makeValidator(engagementCreateSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const body = bodyOf(c);
    const plan = await getRow<any>(ctx.db, `SELECT * FROM audit_plans WHERE id = ?`, body.plan_id);
    if (!plan) throw new AppError(404, "NOT_FOUND", "計画が見つかりません");
    // 年度ごとのグローバル連番（案件番号 AUD-YYYY-NNNN は年度単位で一意）
    const cnt = await getRow<any>(
      ctx.db,
      `SELECT COUNT(*) AS n FROM engagements e JOIN audit_plans p ON p.id = e.plan_id WHERE p.fiscal_year = ?`,
      plan.fiscal_year
    );
    const seq = (cnt?.n ?? 0) + 1;
    const no = engagementNo(plan.fiscal_year, seq);
    const id = newId("eng");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO engagements (id, engagement_no, plan_id, title, scope, criteria, department, classification, status, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      id, no, body.plan_id, body.title, body.scope, body.criteria, body.department, body.classification, ctx.user!.id, ts, ts
    );
    await addMemberIfAuditor(ctx, id, ctx.user!.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "engagement_created", objectType: "engagement", objectId: id, detail: no, ip: ctx.ip });
    return c.json({ id, engagement_no: no }, 201);
  });

  app.get("/api/engagements/:id", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const members = await getRows<any>(
      ctx.db,
      `SELECT m.id, m.role_in_engagement, m.conflict_flagged, u.name, u.email, u.role AS user_role FROM engagement_members m JOIN users u ON u.id = m.user_id WHERE m.engagement_id = ?`,
      engagement.id
    );
    const requests = await getRows<any>(ctx.db, `SELECT * FROM evidence_requests WHERE engagement_id = ? ORDER BY created_at`, engagement.id);
    const workpapers = await getRows<any>(ctx.db, `SELECT * FROM workpapers WHERE engagement_id = ? ORDER BY code`, engagement.id);
    const findings = await getRows<any>(ctx.db, `SELECT * FROM findings WHERE engagement_id = ? ORDER BY created_at`, engagement.id);
    return c.json({ engagement, members, requests, workpapers, findings });
  });

  app.put("/api/engagements/:id", requireAuth(), requirePerm("engagement:update"), makeValidator(engagementUpdateSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const body = bodyOf(c);
    await run(
      ctx.db,
      `UPDATE engagements SET title = ?, scope = ?, criteria = ?, department = ?, classification = ?, updated_at = ? WHERE id = ?`,
      body.title ?? engagement.title,
      body.scope ?? engagement.scope,
      body.criteria ?? engagement.criteria,
      body.department ?? engagement.department,
      body.classification ?? engagement.classification,
      nowIso(),
      engagement.id
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "engagement_updated", objectType: "engagement", objectId: engagement.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/engagements/:id/status", requireAuth(), requirePerm("engagement:status"), makeValidator(statusSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const next = bodyOf(c).status;
    if (!(next in ENGAGEMENT_TRANSITIONS)) throw new AppError(400, "BAD_REQUEST", "不正な状態です");
    assertTransition(ENGAGEMENT_TRANSITIONS, engagement.status, next, "監査案件");
    await run(ctx.db, `UPDATE engagements SET status = ?, updated_at = ? WHERE id = ?`, next, nowIso(), engagement.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "engagement_status", objectType: "engagement", objectId: engagement.id, detail: `${engagement.status}->${next}`, ip: ctx.ip });
    return c.json({ ok: true });
  });

  // ---------- 証憑依頼 ----------
  app.get("/api/engagements/:id/requests", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const requests = await getRows<any>(ctx.db, `SELECT * FROM evidence_requests WHERE engagement_id = ? ORDER BY created_at`, engagement.id);
    const withSubs: any[] = [];
    for (const r of requests) {
      const subs = await getRows<any>(ctx.db, `SELECT * FROM submissions WHERE request_id = ? ORDER BY submitted_at`, r.id);
      withSubs.push({ ...r, submissions: subs });
    }
    return c.json({ requests: withSubs });
  });

  app.post("/api/engagements/:id/requests", requireAuth(), requirePerm("request:create"), makeValidator(requestCreateSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const body = bodyOf(c);
    const plan = await getRow<any>(ctx.db, `SELECT fiscal_year FROM audit_plans WHERE id = ?`, engagement.plan_id);
    // 依頼番号 REQ-YYYY-NNNN は年度単位で一意（年度グローバル連番）
    const cnt = await getRow<any>(
      ctx.db,
      `SELECT COUNT(*) AS n FROM evidence_requests r JOIN engagements e ON e.id = r.engagement_id JOIN audit_plans p ON p.id = e.plan_id WHERE p.fiscal_year = ?`,
      plan?.fiscal_year ?? fiscalYear()
    );
    const seq = (cnt?.n ?? 0) + 1;
    const no = requestNo(plan?.fiscal_year ?? fiscalYear(), seq);
    const id = newId("req");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO evidence_requests (id, request_no, engagement_id, recipient_department, item, purpose, due_at, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      id, no, engagement.id, body.recipient_department, body.item, body.purpose, body.due_at ?? null, ctx.user!.id, ts, ts
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "request_created", objectType: "evidence_request", objectId: id, detail: no, ip: ctx.ip });
    return c.json({ id, request_no: no }, 201);
  });

  app.post("/api/requests/:id/send", requireAuth(), requirePerm("request:send"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const r = await getRow<any>(ctx.db, `SELECT * FROM evidence_requests WHERE id = ?`, c.req.param("id"));
    if (!r) throw new AppError(404, "NOT_FOUND", "依頼が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, r.engagement_id));
    assertTransition(REQUEST_TRANSITIONS, r.status, "sent", "証憑依頼");
    await run(ctx.db, `UPDATE evidence_requests SET status = 'sent', updated_at = ? WHERE id = ?`, nowIso(), r.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "request_sent", objectType: "evidence_request", objectId: r.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/requests/:id/receive", requireAuth(), requirePerm("request:send"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const r = await getRow<any>(ctx.db, `SELECT * FROM evidence_requests WHERE id = ?`, c.req.param("id"));
    if (!r) throw new AppError(404, "NOT_FOUND", "依頼が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, r.engagement_id));
    assertTransition(REQUEST_TRANSITIONS, r.status, "received", "証憑依頼");
    await run(ctx.db, `UPDATE evidence_requests SET status = 'received', updated_at = ? WHERE id = ?`, nowIso(), r.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "request_received", objectType: "evidence_request", objectId: r.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/requests/:id/return", requireAuth(), requirePerm("request:send"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const r = await getRow<any>(ctx.db, `SELECT * FROM evidence_requests WHERE id = ?`, c.req.param("id"));
    if (!r) throw new AppError(404, "NOT_FOUND", "依頼が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, r.engagement_id));
    assertTransition(REQUEST_TRANSITIONS, r.status, "returned", "証憑依頼");
    await run(ctx.db, `UPDATE evidence_requests SET status = 'returned', updated_at = ? WHERE id = ?`, nowIso(), r.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "request_returned", objectType: "evidence_request", objectId: r.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/requests/:id/close", requireAuth(), requirePerm("request:send"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const r = await getRow<any>(ctx.db, `SELECT * FROM evidence_requests WHERE id = ?`, c.req.param("id"));
    if (!r) throw new AppError(404, "NOT_FOUND", "依頼が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, r.engagement_id));
    assertTransition(REQUEST_TRANSITIONS, r.status, "closed", "証憑依頼");
    await run(ctx.db, `UPDATE evidence_requests SET status = 'closed', updated_at = ? WHERE id = ?`, nowIso(), r.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "request_closed", objectType: "evidence_request", objectId: r.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  // ---------- 証憑提出（被監査部門） ----------
  app.post("/api/requests/:id/submissions", requireAuth(), makeValidator(submissionSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const r = await getRow<any>(ctx.db, `SELECT * FROM evidence_requests WHERE id = ?`, c.req.param("id"));
    if (!r) throw new AppError(404, "NOT_FOUND", "依頼が見つかりません");
    if (!canSubmitToRequest(ctx.user!.role, ctx.user!.department, r.recipient_department)) {
      await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "submission_denied", objectType: "evidence_request", objectId: r.id, result: "denied", ip: ctx.ip });
      throw new AppError(403, "FORBIDDEN", "この依頼への提出権限がありません");
    }
    const body = bodyOf(c);
    // 締切済み・受領済みの依頼への提出は拒否（差戻し後の再提出は可）
    if (!["sent", "partial", "returned"].includes(r.status)) {
      throw new AppError(409, "INVALID_TRANSITION", `この依頼（${r.status}）には証憑を提出できません`);
    }
    const id = newId("sub");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO submissions (id, request_id, submitter_id, file_name, content_hash, note, status, submitted_at) VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?)`,
      id, r.id, ctx.user!.id, body.file_name, body.content_hash, body.note, ts
    );
    // 依頼状態を「一部受領」へ更新（全件受領は監査側の receive 操作で確定）
    await run(ctx.db, `UPDATE evidence_requests SET status = 'partial', updated_at = ? WHERE id = ?`, ts, r.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "submission_created", objectType: "submission", objectId: id, detail: body.file_name, ip: ctx.ip });
    return c.json({ id }, 201);
  });

  // ---------- 監査調書 ----------
  app.get("/api/engagements/:id/workpapers", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const wps = await getRows<any>(ctx.db, `SELECT * FROM workpapers WHERE engagement_id = ? ORDER BY code`, engagement.id);
    const result: any[] = [];
    for (const w of wps) {
      const versions = await getRows<any>(ctx.db, `SELECT * FROM workpaper_versions WHERE workpaper_id = ? ORDER BY version_no DESC`, w.id);
      result.push({ ...w, versions });
    }
    return c.json({ workpapers: result });
  });

  app.post("/api/engagements/:id/workpapers", requireAuth(), requirePerm("workpaper:create"), makeValidator(workpaperSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const body = bodyOf(c);
    if (body.reviewer_id && body.reviewer_id === ctx.user!.id) {
      throw new AppError(409, "CONFLICT", "作成者とレビュー者を分離する必要があります");
    }
    // レビュー者は案件メンバーとして追加（監査役・監査役会の場合）
    if (body.reviewer_id) await addMemberIfAuditor(ctx, engagement.id, body.reviewer_id);
    const id = newId("wp");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO workpapers (id, engagement_id, code, title, owner_id, reviewer_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      id, engagement.id, body.code, body.title, ctx.user!.id, body.reviewer_id ?? null, ts, ts
    );
    const hash = await sha256Hex(body.body + body.conclusion);
    const vid = newId("wpv");
    await run(
      ctx.db,
      `INSERT INTO workpaper_versions (id, workpaper_id, version_no, body, conclusion, content_hash, is_final, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, 0, ?, ?)`,
      vid, id, body.body, body.conclusion, hash, ctx.user!.id, ts
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "workpaper_created", objectType: "workpaper", objectId: id, detail: body.code, ip: ctx.ip });
    return c.json({ id }, 201);
  });

  app.get("/api/workpapers/:id", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const w = await getRow<any>(ctx.db, `SELECT * FROM workpapers WHERE id = ?`, c.req.param("id"));
    if (!w) throw new AppError(404, "NOT_FOUND", "調書が見つかりません");
    const engagement = await loadEngagement(ctx, w.engagement_id);
    await checkEngagementAccess(ctx, engagement);
    const versions = await getRows<any>(ctx.db, `SELECT * FROM workpaper_versions WHERE workpaper_id = ? ORDER BY version_no DESC`, w.id);
    return c.json({ workpaper: w, versions });
  });

  app.put("/api/workpapers/:id", requireAuth(), requirePerm("workpaper:create"), makeValidator(workpaperUpdateSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const w = await getRow<any>(ctx.db, `SELECT * FROM workpapers WHERE id = ?`, c.req.param("id"));
    if (!w) throw new AppError(404, "NOT_FOUND", "調書が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, w.engagement_id));
    if (w.owner_id !== ctx.user!.id) throw new AppError(403, "FORBIDDEN", "作成者のみ調書を変更できます");
    if (w.status === "final" || w.status === "approved") throw new AppError(409, "VERSION_CONFLICT", "確定済みの調書は変更できません。追補版を作成してください");
    if (w.status === "review_requested") throw new AppError(409, "INVALID_TRANSITION", "レビュー中の調書は変更できません。差戻し後に修正してください");
    const body = bodyOf(c);
    // 最新版を取得
    const latest = await getRow<any>(ctx.db, `SELECT * FROM workpaper_versions WHERE workpaper_id = ? ORDER BY version_no DESC LIMIT 1`, w.id);
    const newBody = body.body ?? latest?.body ?? "";
    const newConclusion = body.conclusion ?? latest?.conclusion ?? "";
    const newVersionNo = (latest?.version_no ?? 0) + 1;
    const hash = await sha256Hex(newBody + newConclusion);
    const vid = newId("wpv");
    await run(
      ctx.db,
      `INSERT INTO workpaper_versions (id, workpaper_id, version_no, body, conclusion, content_hash, is_final, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      vid, w.id, newVersionNo, newBody, newConclusion, hash, ctx.user!.id, nowIso()
    );
    if (body.reviewer_id !== undefined) {
      if (body.reviewer_id === ctx.user!.id) throw new AppError(409, "CONFLICT", "作成者とレビュー者を分離する必要があります");
      await addMemberIfAuditor(ctx, w.engagement_id, body.reviewer_id);
      await run(ctx.db, `UPDATE workpapers SET reviewer_id = ?, updated_at = ? WHERE id = ?`, body.reviewer_id, nowIso(), w.id);
    }
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "workpaper_updated", objectType: "workpaper", objectId: w.id, detail: `v${newVersionNo}`, ip: ctx.ip });
    return c.json({ ok: true, version: newVersionNo });
  });

  app.post("/api/workpapers/:id/review", requireAuth(), requirePerm("workpaper:review"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const w = await getRow<any>(ctx.db, `SELECT * FROM workpapers WHERE id = ?`, c.req.param("id"));
    if (!w) throw new AppError(404, "NOT_FOUND", "調書が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, w.engagement_id));
    if (w.owner_id !== ctx.user!.id) throw new AppError(403, "FORBIDDEN", "作成者のみレビュー依頼できます");
    assertTransition(WORKPAPER_TRANSITIONS, w.status, "review_requested", "監査調書");
    if (!w.reviewer_id) throw new AppError(400, "BAD_REQUEST", "レビュー担当者が設定されていません");
    if (w.reviewer_id === w.owner_id) throw new AppError(409, "CONFLICT", "作成者とレビュー者を分離する必要があります");
    await run(ctx.db, `UPDATE workpapers SET status = 'review_requested', updated_at = ? WHERE id = ?`, nowIso(), w.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "workpaper_review_requested", objectType: "workpaper", objectId: w.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/workpapers/:id/approve", requireAuth(), requirePerm("workpaper:approve"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const w = await getRow<any>(ctx.db, `SELECT * FROM workpapers WHERE id = ?`, c.req.param("id"));
    if (!w) throw new AppError(404, "NOT_FOUND", "調書が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, w.engagement_id));
    if (ctx.user!.id !== w.reviewer_id) throw new AppError(403, "FORBIDDEN", "レビュー担当者のみ確定できます");
    assertTransition(WORKPAPER_TRANSITIONS, w.status, "final", "監査調書");
    const latest = await getRow<any>(ctx.db, `SELECT * FROM workpaper_versions WHERE workpaper_id = ? ORDER BY version_no DESC LIMIT 1`, w.id);
    await run(ctx.db, `UPDATE workpaper_versions SET is_final = 1 WHERE id = ?`, latest.id);
    await run(ctx.db, `UPDATE workpapers SET status = 'final', updated_at = ? WHERE id = ?`, nowIso(), w.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "workpaper_approved", objectType: "workpaper", objectId: w.id, detail: `v${latest.version_no}`, ip: ctx.ip });
    return c.json({ ok: true });
  });

  app.post("/api/workpapers/:id/return", requireAuth(), requirePerm("workpaper:review"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const w = await getRow<any>(ctx.db, `SELECT * FROM workpapers WHERE id = ?`, c.req.param("id"));
    if (!w) throw new AppError(404, "NOT_FOUND", "調書が見つかりません");
    await checkEngagementAccess(ctx, await loadEngagement(ctx, w.engagement_id));
    if (ctx.user!.id !== w.reviewer_id) throw new AppError(403, "FORBIDDEN", "レビュー担当者のみ差戻しできます");
    assertTransition(WORKPAPER_TRANSITIONS, w.status, "returned", "監査調書");
    await run(ctx.db, `UPDATE workpapers SET status = 'returned', updated_at = ? WHERE id = ?`, nowIso(), w.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "workpaper_returned", objectType: "workpaper", objectId: w.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  // ---------- 発見事項・指摘 ----------
  app.get("/api/engagements/:id/findings", requireAuth(), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const findings = await getRows<any>(ctx.db, `SELECT * FROM findings WHERE engagement_id = ? ORDER BY created_at`, engagement.id);
    const result: any[] = [];
    for (const f of findings) {
      const responses = await getRows<any>(ctx.db, `SELECT * FROM finding_responses WHERE finding_id = ? ORDER BY created_at`, f.id);
      const remediations = await getRows<any>(ctx.db, `SELECT * FROM remediations WHERE finding_id = ? ORDER BY created_at`, f.id);
      result.push({ ...f, responses, remediations });
    }
    return c.json({ findings: result });
  });

  app.post("/api/engagements/:id/findings", requireAuth(), requirePerm("finding:create"), makeValidator(findingSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const engagement = await loadEngagement(ctx, c.req.param("id"));
    await checkEngagementAccess(ctx, engagement);
    const body = bodyOf(c);
    const plan = await getRow<any>(ctx.db, `SELECT fiscal_year FROM audit_plans WHERE id = ?`, engagement.plan_id);
    // 指摘番号 FND-YYYY-NNNN は年度単位で一意（年度グローバル連番）
    const cnt = await getRow<any>(
      ctx.db,
      `SELECT COUNT(*) AS n FROM findings f JOIN engagements e ON e.id = f.engagement_id JOIN audit_plans p ON p.id = e.plan_id WHERE p.fiscal_year = ?`,
      plan?.fiscal_year ?? fiscalYear()
    );
    const seq = (cnt?.n ?? 0) + 1;
    const no = findingNo(plan?.fiscal_year ?? fiscalYear(), seq);
    const id = newId("fnd");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO findings (id, finding_no, engagement_id, fact, criterion, cause, impact, severity, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      id, no, engagement.id, body.fact, body.criterion, body.cause, body.impact, body.severity, ctx.user!.id, ts, ts
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "finding_created", objectType: "finding", objectId: id, detail: no, ip: ctx.ip });
    return c.json({ id, finding_no: no }, 201);
  });

  app.post("/api/findings/:id/responses", requireAuth(), requirePerm("finding:respond"), makeValidator(findingResponseSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const f = await getRow<any>(ctx.db, `SELECT * FROM findings WHERE id = ?`, c.req.param("id"));
    if (!f) throw new AppError(404, "NOT_FOUND", "指摘が見つかりません");
    const engagement = await loadEngagement(ctx, f.engagement_id);
    await checkEngagementAccess(ctx, engagement);
    // 被監査部門は自部門の案件のみ回答可能
    if (ctx.user!.role === "auditee" && engagement.department !== ctx.user!.department) {
      throw new AppError(403, "FORBIDDEN", "この指摘への回答権限がありません");
    }
    assertTransition(FINDING_TRANSITIONS, f.status, "fact_check", "指摘");
    const body = bodyOf(c);
    const id = newId("fres");
    await run(
      ctx.db,
      `INSERT INTO finding_responses (id, finding_id, respondent_id, response, disagreement, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      id, f.id, ctx.user!.id, body.response, body.disagreement, nowIso()
    );
    await run(ctx.db, `UPDATE findings SET status = 'fact_check', updated_at = ? WHERE id = ?`, nowIso(), f.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "finding_response", objectType: "finding", objectId: f.id, ip: ctx.ip });
    return c.json({ id }, 201);
  });

  app.post("/api/findings/:id/confirm", requireAuth(), requirePerm("finding:confirm"), makeValidator(findingConfirmSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const f = await getRow<any>(ctx.db, `SELECT * FROM findings WHERE id = ?`, c.req.param("id"));
    if (!f) throw new AppError(404, "NOT_FOUND", "指摘が見つかりません");
    const engagement = await loadEngagement(ctx, f.engagement_id);
    await checkEngagementAccess(ctx, engagement);
    assertTransition(FINDING_TRANSITIONS, f.status, "confirmed", "指摘");
    const body = bodyOf(c);
    await run(
      ctx.db,
      `UPDATE findings SET status = 'confirmed', severity = ?, updated_at = ? WHERE id = ?`,
      body.severity ?? f.severity, nowIso(), f.id
    );
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "finding_confirmed", objectType: "finding", objectId: f.id, ip: ctx.ip });
    return c.json({ ok: true });
  });

  // ---------- 是正・フォローアップ ----------
  app.post("/api/findings/:id/remediations", requireAuth(), requirePerm("remediation:create"), makeValidator(remediationSchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const f = await getRow<any>(ctx.db, `SELECT * FROM findings WHERE id = ?`, c.req.param("id"));
    if (!f) throw new AppError(404, "NOT_FOUND", "指摘が見つかりません");
    const engagement = await loadEngagement(ctx, f.engagement_id);
    await checkEngagementAccess(ctx, engagement);
    // 被監査部門は自部門の案件のみ是正計画を登録可能（監査役は全案件可）
    if (ctx.user!.role === "auditee" && engagement.department !== ctx.user!.department) {
      throw new AppError(403, "FORBIDDEN", "この指摘への是正登録権限がありません");
    }
    assertTransition(FINDING_TRANSITIONS, f.status, "remediated", "指摘");
    const body = bodyOf(c);
    const id = newId("rem");
    const ts = nowIso();
    await run(
      ctx.db,
      `INSERT INTO remediations (id, finding_id, action, owner_id, due_at, evidence_note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', 'planned', ?, ?)`,
      id, f.id, body.action, body.owner_id, body.due_at ?? null, ts, ts
    );
    await run(ctx.db, `UPDATE findings SET status = 'remediated', updated_at = ? WHERE id = ?`, ts, f.id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "remediation_created", objectType: "remediation", objectId: id, ip: ctx.ip });
    return c.json({ id }, 201);
  });

  app.post("/api/remediations/:id/verify", requireAuth(), requirePerm("remediation:verify"), makeValidator(remediationVerifySchema), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const r = await getRow<any>(ctx.db, `SELECT * FROM remediations WHERE id = ?`, c.req.param("id"));
    if (!r) throw new AppError(404, "NOT_FOUND", "是正計画が見つかりません");
    const f = await getRow<any>(ctx.db, `SELECT * FROM findings WHERE id = ?`, r.finding_id);
    if (f) await checkEngagementAccess(ctx, await loadEngagement(ctx, f.engagement_id));
    assertTransition(FINDING_TRANSITIONS, f?.status ?? "", "completed", "指摘");
    const body = bodyOf(c);
    const ts = nowIso();
    await run(
      ctx.db,
      `UPDATE remediations SET status = 'completed', verified_by = ?, verified_at = ?, verified_result = ?, evidence_note = ?, updated_at = ? WHERE id = ?`,
      ctx.user!.id, ts, body.result, body.evidence_note, ts, r.id
    );
    // 完了か継続監視か再指摘（人の判断）— ここでは完了として記録
    await run(ctx.db, `UPDATE findings SET status = 'completed', updated_at = ? WHERE id = ?`, ts, r.finding_id);
    await writeAuditEvent(ctx.db, { actorId: ctx.user!.id, action: "remediation_verified", objectType: "remediation", objectId: r.id, detail: body.result, ip: ctx.ip });
    return c.json({ ok: true });
  });

  // ---------- 監査ログ ----------
  app.get("/api/audit-events", requireAuth(), requirePerm("auditlog:view"), async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    const q = c.req.query();
    const events = await queryAuditEvents(ctx.db, {
      limit: q.limit ? Number(q.limit) : 100,
      actorId: q.actor_id,
      objectType: q.object_type,
      objectId: q.object_id,
      action: q.action,
    });
    return c.json({ events });
  });

  // ---------- 管理（シード・初期化） ----------
  // preview/mvp/local のみ。本番環境では常に拒否。初期パスワードは環境変数 BOOTSTRAP_PASSWORD が必須
  app.post("/api/admin/bootstrap", async (c) => {
    const ctx = c.get(CTX_KEY) as AppContext;
    if (deps.environment !== "preview" && deps.environment !== "mvp" && deps.environment !== "local") {
      throw new AppError(403, "FORBIDDEN", "本番ではbootstrapを実行できません");
    }
    limiter(`bootstrap:${ctx.ip}`, 3, 60_000);
    const count = await getRow<any>(ctx.db, `SELECT COUNT(*) AS n FROM users`);
    if ((count?.n ?? 0) > 0) throw new AppError(409, "CONFLICT", "ユーザーが既に存在します");
    // テスト環境であっても既定パスワードのハードコードを避け、BOOTSTRAP_PASSWORD を必須とする
    if (!deps.bootstrapPassword) {
      throw new AppError(403, "FORBIDDEN", "BOOTSTRAP_PASSWORD が未設定のため初期化できません");
    }
    const ts = nowIso();
    const bootstrapPassword = deps.bootstrapPassword;
    const users: Array<{ email: string; name: string; role: Role; department: string }> = [
      { email: "admin@mirai.local", name: "システム管理者", role: "admin", department: "情報システム部" },
      { email: "auditor@mirai.local", name: "監査役（山田）", role: "auditor", department: "監査役室" },
      { email: "committee@mirai.local", name: "監査役会（佐藤）", role: "audit_committee", department: "監査役会" },
      { email: "ga@mirai.local", name: "総務部（鈴木）", role: "general_affairs", department: "総務部" },
      { email: "kensetsu@mirai.local", name: "建設部（田中）", role: "auditee", department: "建設部" },
      { email: "zaimu@mirai.local", name: "財務部（高橋）", role: "auditee", department: "財務部" },
    ];
    for (const { email, name, role, department } of users) {
      const id = newId("usr");
      const hash = await hashPassword(bootstrapPassword);
      await run(
        ctx.db,
        `INSERT INTO users (id, email, name, role, department, active, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        id, email, name, role, department, hash, ts, ts
      );
    }
    return c.json({ ok: true, users: users.length });
  });

  // SPA フォールバック（API以外は埋め込みHTMLを返す）
  app.get("/", async (c) => {
    return c.html(EMBEDDED_INDEX_HTML);
  });
  app.all("/{path*}", async (c) => {
    const path = c.req.path;
    if (path.startsWith("/api/")) {
      throw new AppError(404, "NOT_FOUND", "APIが見つかりません");
    }
    return c.html(EMBEDDED_INDEX_HTML);
  });

  return app;
}
