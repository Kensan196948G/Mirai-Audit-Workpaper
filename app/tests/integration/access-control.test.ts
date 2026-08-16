// 統合テスト — アクセス制御・採番・状態機械（独立レビュー指摘 P1-1〜P1-6 の回帰）
// - 非メンバー監査役が他案件の依頼を操作できない（P1-1）
// - 他部門の被監査部門が他案件の指摘に是正登録できない（P1-2）
// - 作成者以外が調書を編集・レビュー依頼できない（P1-3）
// - 被監査部門・管理者が年度計画を閲覧できない（P1-4）
// - 指摘の不正な状態遷移を拒否する（P1-5）
// - 年度グローバル連番で採番衝突が発生しない（P1-6）

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildApp, type AppDeps } from "../../src/app.ts";
import { createTestDb, type TestUserSeed } from "./helpers.ts";

const USERS: TestUserSeed[] = [
  { email: "admin@test.local", name: "管理者", role: "admin", department: "情報システム部", password: "TestPass2026!" },
  { email: "auditor1@test.local", name: "監査役1", role: "auditor", department: "監査役室", password: "TestPass2026!" },
  { email: "auditor2@test.local", name: "監査役2", role: "auditor", department: "監査役室", password: "TestPass2026!" },
  { email: "committee@test.local", name: "監査役会", role: "audit_committee", department: "監査役会", password: "TestPass2026!" },
  { email: "kensetsu@test.local", name: "建設部", role: "auditee", department: "建設部", password: "TestPass2026!" },
  { email: "zaimu@test.local", name: "財務部", role: "auditee", department: "財務部", password: "TestPass2026!" },
];

async function buildTestApp() {
  const db = await createTestDb(USERS);
  const deps: AppDeps = { db, environment: "test", getClientIp: () => "203.0.113.50" };
  return buildApp(deps);
}

async function login(app: any, email: string, password: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  );
  assert.equal(res.status, 200, `login failed: ${email}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function authedFetch(app: any, cookie: string, path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers ?? {}) },
    })
  );
}

async function createPlan(app: any, cookie: string, fiscalYear = "2026") {
  const res = await authedFetch(app, cookie, "/api/plans", {
    method: "POST",
    body: JSON.stringify({ fiscal_year: fiscalYear, title: "2026年度監査", policy: "" }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

async function createEngagement(app: any, cookie: string, planId: string, department = "建設部") {
  const res = await authedFetch(app, cookie, "/api/engagements", {
    method: "POST",
    body: JSON.stringify({ plan_id: planId, title: `${department}監査`, scope: "", criteria: "", department, classification: "C2" }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; engagement_no: string };
}

describe("integration: access control (P1-1..P1-4)", () => {
  test("non-member auditor cannot operate another engagement's request (P1-1)", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const a2 = await login(app, "auditor2@test.local", "TestPass2026!");
    const plan = await createPlan(app, a1);
    const eng = await createEngagement(app, a1, plan.id);

    // a1 が依頼作成・送付（a1 は案件メンバー自動追加済み）
    const reqRes = await authedFetch(app, a1, `/api/engagements/${eng.id}/requests`, {
      method: "POST",
      body: JSON.stringify({ recipient_department: "建設部", item: "契約書一覧", purpose: "", due_at: null }),
    });
    const req = (await reqRes.json()) as { id: string };

    // a2（非メンバー）が送付・受領・締切を試行 → 403
    for (const action of ["send", "receive", "return", "close"]) {
      const res = await authedFetch(app, a2, `/api/requests/${req.id}/${action}`, { method: "POST" });
      assert.equal(res.status, 403, `${action} should be denied for non-member`);
    }
    // a1（メンバー）は送付可能
    assert.equal((await authedFetch(app, a1, `/api/requests/${req.id}/send`, { method: "POST" })).status, 200);
  });

  test("non-member auditor cannot submit evidence to another engagement's request", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const a2 = await login(app, "auditor2@test.local", "TestPass2026!");
    const plan = await createPlan(app, a1);
    const eng = await createEngagement(app, a1, plan.id);
    const reqRes = await authedFetch(app, a1, `/api/engagements/${eng.id}/requests`, {
      method: "POST",
      body: JSON.stringify({ recipient_department: "建設部", item: "契約書一覧", purpose: "", due_at: null }),
    });
    const req = (await reqRes.json()) as { id: string };
    // a2（非メンバー）は ID を知っていても提出できない（他案件への書き込み防止）
    const res = await authedFetch(app, a2, `/api/requests/${req.id}/submissions`, {
      method: "POST",
      body: JSON.stringify({ file_name: "contract.pdf", content_hash: "abc123", note: "" }),
    });
    assert.equal(res.status, 403);
    // 拒否は案件アクセス拒否として監査ログに残る
    const events = await authedFetch(app, a1, "/api/audit-events?action=engagement_access_denied");
    const ev = (await events.json()) as { events: Array<{ result: string }> };
    assert.ok(ev.events.some((e) => e.result === "denied"));
  });

  test("auditee from other department cannot create remediation (P1-2)", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const zaimu = await login(app, "zaimu@test.local", "TestPass2026!");
    const kensetsuCookie = await login(app, "kensetsu@test.local", "TestPass2026!");
    const meRes = await authedFetch(app, kensetsuCookie, "/api/me");
    const me = (await meRes.json()) as { user: { id: string } };
    const kensetsuId = me.user.id;
    const plan = await createPlan(app, a1);
    const eng = await createEngagement(app, a1, plan.id, "建設部");
    const fndRes = await authedFetch(app, a1, `/api/engagements/${eng.id}/findings`, {
      method: "POST",
      body: JSON.stringify({ fact: "承認漏れ", criterion: "決裁規程", severity: "high" }),
    });
    const fnd = (await fndRes.json()) as { id: string };
    // 財務部ユーザーが建設部案件の指摘に是正登録 → 403
    const res = await authedFetch(app, zaimu, `/api/findings/${fnd.id}/remediations`, {
      method: "POST",
      body: JSON.stringify({ action: "是正", owner_id: kensetsuId, due_at: null }),
    });
    assert.equal(res.status, 403);
  });

  test("non-owner cannot edit or request review of a workpaper (P1-3)", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const a2 = await login(app, "auditor2@test.local", "TestPass2026!");
    const plan = await createPlan(app, a1);
    const eng = await createEngagement(app, a1, plan.id);
    const wpRes = await authedFetch(app, a1, `/api/engagements/${eng.id}/workpapers`, {
      method: "POST",
      body: JSON.stringify({ code: "WP-1", title: "調書", body: "内容", conclusion: "" }),
    });
    const wp = (await wpRes.json()) as { id: string };
    // a2（非作成者・非メンバー）が編集・レビュー依頼 → 403
    const edit = await authedFetch(app, a2, `/api/workpapers/${wp.id}`, {
      method: "PUT",
      body: JSON.stringify({ body: "改ざん" }),
    });
    assert.equal(edit.status, 403);
    const review = await authedFetch(app, a2, `/api/workpapers/${wp.id}/review`, { method: "POST" });
    assert.equal(review.status, 403);
  });

  test("auditee and admin cannot view plans (P1-4)", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");
    const admin = await login(app, "admin@test.local", "TestPass2026!");
    await createPlan(app, a1);
    assert.equal((await authedFetch(app, kensetsu, "/api/plans")).status, 403);
    assert.equal((await authedFetch(app, admin, "/api/plans")).status, 403);
  });
});

describe("integration: finding state machine (P1-5)", () => {
  test("invalid finding transitions are rejected", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");
    const meRes = await authedFetch(app, kensetsu, "/api/me");
    const me = (await meRes.json()) as { user: { id: string } };
    const kensetsuId = me.user.id;
    const plan = await createPlan(app, a1);
    const eng = await createEngagement(app, a1, plan.id);
    const fndRes = await authedFetch(app, a1, `/api/engagements/${eng.id}/findings`, {
      method: "POST",
      body: JSON.stringify({ fact: "承認漏れ", criterion: "決裁規程", severity: "high" }),
    });
    const fnd = (await fndRes.json()) as { id: string };

    // draft のまま completed にできない（是正登録は confirmed から）
    const skip = await authedFetch(app, a1, `/api/findings/${fnd.id}/remediations`, {
      method: "POST",
      body: JSON.stringify({ action: "是正", owner_id: kensetsuId, due_at: null }),
    });
    assert.equal(skip.status, 409);

    // draft → confirmed は正しい遷移
    assert.equal((await authedFetch(app, a1, `/api/findings/${fnd.id}/confirm`, { method: "POST", body: JSON.stringify({ severity: "high" }) })).status, 200);

    // confirmed → 部門回答 → fact_check
    assert.equal((await authedFetch(app, kensetsu, `/api/findings/${fnd.id}/responses`, {
      method: "POST",
      body: JSON.stringify({ response: "改善します", disagreement: "" }),
    })).status, 201);

    // fact_check → confirmed（監査役が再確認）
    assert.equal((await authedFetch(app, a1, `/api/findings/${fnd.id}/confirm`, { method: "POST", body: JSON.stringify({ severity: "high" }) })).status, 200);

    // confirmed → remediated（是正登録）
    assert.equal((await authedFetch(app, a1, `/api/findings/${fnd.id}/remediations`, {
      method: "POST",
      body: JSON.stringify({ action: "承認フロー再設計", owner_id: kensetsuId, due_at: "2026-12-31" }),
    })).status, 201);

    // completed からの巻き戻し（回答）を拒否
    // （is_final 検証のため完了へ進める: verify は remediated→completed）
    // まず remediations を取得して verify を呼ぶ
    const detail = await authedFetch(app, a1, `/api/engagements/${eng.id}/findings`);
    const body = (await detail.json()) as { findings: Array<{ id: string; remediations: Array<{ id: string }> }> };
    const remId = body.findings.find((f) => f.id === fnd.id)!.remediations[0]!.id;
    assert.equal((await authedFetch(app, a1, `/api/remediations/${remId}/verify`, {
      method: "POST",
      body: JSON.stringify({ result: "是正確認済み", evidence_note: "証憑" }),
    })).status, 200);
    // completed からの回答 → 409
    const after = await authedFetch(app, kensetsu, `/api/findings/${fnd.id}/responses`, {
      method: "POST",
      body: JSON.stringify({ response: "遅すぎる回答", disagreement: "" }),
    });
    assert.equal(after.status, 409);
  });
});

describe("integration: fiscal-year global numbering (P1-6)", () => {
  test("two plans in same year get non-colliding engagement numbers", async () => {
    const app = await buildTestApp();
    const a1 = await login(app, "auditor1@test.local", "TestPass2026!");
    const plan1 = await createPlan(app, a1);
    const plan2 = await createPlan(app, a1);
    const eng1 = await createEngagement(app, a1, plan1.id, "建設部");
    const eng2 = await createEngagement(app, a1, plan2.id, "財務部");
    assert.notEqual(eng1.engagement_no, eng2.engagement_no);
    assert.match(eng1.engagement_no, /^AUD-2026-\d{4}$/);
    assert.match(eng2.engagement_no, /^AUD-2026-\d{4}$/);
  });
});
