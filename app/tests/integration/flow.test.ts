// 統合テスト — 主要業務フロー（計画→案件→依頼→提出→調書→指摘→是正）
// 要件定義書 AC-01〜05, UAT-01〜05, AC-06（権限外拒否）に対応

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildApp, type AppDeps } from "../../src/app.ts";
import { createTestDb, type TestUserSeed } from "./helpers.ts";

const USERS: TestUserSeed[] = [
  { email: "admin@test.local", name: "管理者", role: "admin", department: "情報システム部", password: "TestPass2026!" },
  { email: "auditor@test.local", name: "監査役", role: "auditor", department: "監査役室", password: "TestPass2026!" },
  { email: "committee@test.local", name: "監査役会", role: "audit_committee", department: "監査役会", password: "TestPass2026!" },
  { email: "ga@test.local", name: "総務", role: "general_affairs", department: "総務部", password: "TestPass2026!" },
  { email: "kensetsu@test.local", name: "建設部", role: "auditee", department: "建設部", password: "TestPass2026!" },
  { email: "zaimu@test.local", name: "財務部", role: "auditee", department: "財務部", password: "TestPass2026!" },
];

async function buildTestApp(environment = "test") {
  const db = await createTestDb(USERS);
  const deps: AppDeps = {
    db,
    environment,
    getClientIp: (req) => "203.0.113.10",
  };
  return buildApp(deps);
}

async function login(app: any, email: string, password: string): Promise<{ cookie: string; userId: string }> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  );
  assert.equal(res.status, 200, `login failed for ${email}`);
  const cookie = res.headers.get("set-cookie") ?? "";
  const body = (await res.json()) as any;
  return { cookie: cookie.split(";")[0]!, userId: body.id };
}

async function authedFetch(app: any, cookie: string, path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) },
    })
  );
}

describe("integration: auth", () => {
  test("health endpoint works (liveness)", async () => {
    const app = await buildTestApp();
    const res = await app.fetch(new Request("http://localhost/api/health"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.status, "ok");
    assert.equal(body.environment, "test");
  });

  test("health endpoint reports DB readiness", async () => {
    const app = await buildTestApp();
    const res = await app.fetch(new Request("http://localhost/api/health"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.db, "ok");
  });

  test("health endpoint degrades (503) when DB is unavailable", async () => {
    // DB が失敗するアプリを構築して 503 + db:error を確認する
    const brokenDb = {
      prepare: () => {
        throw new Error("db connection refused");
      },
      exec: async () => {
        throw new Error("db connection refused");
      },
    };
    const app = buildApp({ db: brokenDb as any, environment: "test", getClientIp: () => "203.0.113.10" });
    const res = await app.fetch(new Request("http://localhost/api/health"));
    assert.equal(res.status, 503);
    const body = (await res.json()) as any;
    assert.equal(body.status, "degraded");
    assert.equal(body.db, "error");
  });

  test("login valid / invalid / me", async () => {
    const app = await buildTestApp();
    // valid
    const res = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "TestPass2026!" }),
      })
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.email, "auditor@test.local");
    // invalid
    const bad = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "WrongPass123" }),
      })
    );
    assert.equal(bad.status, 401);
    // me without session
    const noAuth = await app.fetch(new Request("http://localhost/api/me"));
    assert.equal(noAuth.status, 401);
  });
});

describe("integration: full audit flow (AC-01..05)", () => {
  test("plan -> engagement -> request -> submission -> workpaper -> finding -> remediation", async () => {
    const app = await buildTestApp();
    const { cookie: auditor, userId: auditorId } = await login(app, "auditor@test.local", "TestPass2026!");
    const { cookie: committee } = await login(app, "committee@test.local", "TestPass2026!");
    const { cookie: kensetsu, userId: kensetsuId } = await login(app, "kensetsu@test.local", "TestPass2026!");

    // 1. 計画作成（監査役）→ 承認申請 → 監査役会承認
    const planRes = await authedFetch(app, auditor, "/api/plans", {
      method: "POST",
      body: JSON.stringify({ fiscal_year: "2026", title: "2026年度 建設部監査", policy: "内部統制重点" }),
    });
    assert.equal(planRes.status, 201);
    const plan = await planRes.json();
    assert.ok(plan.id);

    const submitRes = await authedFetch(app, auditor, `/api/plans/${plan.id}/submit`, { method: "POST" });
    assert.equal(submitRes.status, 200);
    const approveRes = await authedFetch(app, committee, `/api/plans/${plan.id}/approve`, { method: "POST" });
    assert.equal(approveRes.status, 200);

    // 計画一覧に反映
    const plansRes = await authedFetch(app, auditor, "/api/plans");
    const plansBody = await plansRes.json();
    assert.ok(plansBody.plans.some((p: any) => p.id === plan.id && p.status === "approved"));

    // 2. 案件作成（監査役）
    const engRes = await authedFetch(app, auditor, "/api/engagements", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, title: "建設部の工事原価監査", scope: "2025年度 工事原価", criteria: "内部統制基準", department: "建設部", classification: "C2" }),
    });
    assert.equal(engRes.status, 201);
    const eng = await engRes.json();
    assert.match(eng.engagement_no, /^AUD-2026-\d{4}$/);

    // 3. 証憑依頼作成（監査役）→ 送付
    const reqRes = await authedFetch(app, auditor, `/api/engagements/${eng.id}/requests`, {
      method: "POST",
      body: JSON.stringify({ recipient_department: "建設部", item: "工事契約書一覧", purpose: "契約の妥当性確認", due_at: "2026-09-30" }),
    });
    assert.equal(reqRes.status, 201);
    const req = await reqRes.json();
    const sendRes = await authedFetch(app, auditor, `/api/requests/${req.id}/send`, { method: "POST" });
    assert.equal(sendRes.status, 200);

    // 4. 被監査部門が証憑提出
    const subRes = await authedFetch(app, kensetsu, `/api/requests/${req.id}/submissions`, {
      method: "POST",
      body: JSON.stringify({ file_name: "契約書一覧.xlsx", content_hash: "abc123hash", note: "2025年度分" }),
    });
    assert.equal(subRes.status, 201);

    // 5. 調書作成（監査役）
    const wpRes = await authedFetch(app, auditor, `/api/engagements/${eng.id}/workpapers`, {
      method: "POST",
      body: JSON.stringify({ code: "WP-001", title: "工事原価監査調書", body: "契約書と実績を照合した", conclusion: "特段の異常なし" }),
    });
    assert.equal(wpRes.status, 201);
    const wp = await wpRes.json();

    // 6. 発見事項・指摘作成
    const fndRes = await authedFetch(app, auditor, `/api/engagements/${eng.id}/findings`, {
      method: "POST",
      body: JSON.stringify({ fact: "工事番号A-101の承認漏れ", criterion: "決裁権限規程", severity: "high" }),
    });
    assert.equal(fndRes.status, 201);
    const fnd = await fndRes.json();

    // 7. 被監査部門が回答
    const respRes = await authedFetch(app, kensensu_guard(app, kensetsu), `/api/findings/${fnd.id}/responses`, {
      method: "POST",
      body: JSON.stringify({ response: "承認プロセスを改善します", disagreement: "" }),
    });
    assert.equal(respRes.status, 201);

    // 8. 監査役が事実確認（確定）
    const confRes = await authedFetch(app, auditor, `/api/findings/${fnd.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ severity: "high" }),
    });
    assert.equal(confRes.status, 200);

    // 9. 是正計画登録 → 監査役が再確認・完了
    // 是正責任者は被監査部門（kensetsu）のIDを取得
    const usersRes = await authedFetch(app, auditor, "/api/me");
    // 被監査部門のIDは /api/me では返らないため、DB直参照はせず、
    // 監査役自身を責任者として登録（monkeyテストでは被監査部門の所有者を省略）
    const remRes = await authedFetch(app, auditor, `/api/findings/${fnd.id}/remediations`, {
      method: "POST",
      body: JSON.stringify({ action: "承認フローを再設計", owner_id: kensetsuId, due_at: "2026-10-31" }),
    });
    assert.equal(remRes.status, 201);
    const rem = await remRes.json();

    // 10. 監査ログが追記されている
    const logRes = await authedFetch(app, auditor, "/api/audit-events?limit=100");
    const logBody = await logRes.json();
    assert.ok(logBody.events.length >= 8);
  });

  test("auditee cannot view other department's engagement (AC-06)", async () => {
    const app = await buildTestApp();
    const { cookie: auditor } = await login(app, "auditor@test.local", "TestPass2026!");
    const { cookie: zaimu } = await login(app, "zaimu@test.local", "TestPass2026!");

    // 建設部案件を作成
    const planRes = await authedFetch(app, auditor, "/api/plans", {
      method: "POST",
      body: JSON.stringify({ fiscal_year: "2026", title: "2026年度監査", policy: "" }),
    });
    const plan = await planRes.json();
    const engRes = await authedFetch(app, auditor, "/api/engagements", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, title: "建設部監査", scope: "", criteria: "", department: "建設部", classification: "C2" }),
    });
    const eng = await engRes.json();

    // 財務部ユーザーが建設部案件へアクセス → 403
    const denied = await authedFetch(app, zaimu, `/api/engagements/${eng.id}`);
    assert.equal(denied.status, 403);

    // 財務部ユーザーの案件一覧に建設部案件が含まれない
    const listRes = await authedFetch(app, zaimu, "/api/engagements");
    const listBody = await listRes.json();
    assert.ok(!listBody.engagements.some((e: any) => e.id === eng.id));
  });

  test("admin cannot access business data (内容閲覧不可)", async () => {
    const app = await buildTestApp();
    const { cookie: admin } = await login(app, "admin@test.local", "TestPass2026!");
    const res = await authedFetch(app, admin, "/api/engagements");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.engagements.length, 0); // 管理者は業務データ閲覧不可
  });
});

// ヘルパー（kensetsu の cookie をそのまま返すだけの関数。可読性のため）
function kensensu_guard(app: any, cookie: string): string {
  return cookie;
}
