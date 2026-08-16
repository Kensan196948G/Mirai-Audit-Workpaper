// 統合テスト — 是正計画の状態遷移（planned→in_progress→submitted、不正遷移の拒否）

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildApp, type AppDeps } from "../../src/app.ts";
import { createTestDb, type TestUserSeed } from "./helpers.ts";

const USERS: TestUserSeed[] = [
  { email: "admin@test.local", name: "管理者", role: "admin", department: "情報システム部", password: "TestPass2026!" },
  { email: "auditor@test.local", name: "監査役", role: "auditor", department: "監査役室", password: "TestPass2026!" },
  { email: "kensetsu@test.local", name: "建設部", role: "auditee", department: "建設部", password: "TestPass2026!" },
  { email: "zaimu@test.local", name: "財務部", role: "auditee", department: "財務部", password: "TestPass2026!" },
];

async function buildTestApp() {
  const db = await createTestDb(USERS);
  const deps: AppDeps = { db, environment: "test", getClientIp: () => "203.0.113.80" };
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

async function createPlanAndEngagement(app: any, auditorCookie: string, department = "建設部") {
  const planRes = await authedFetch(app, auditorCookie, "/api/plans", {
    method: "POST",
    body: JSON.stringify({ fiscal_year: "2026", title: "計画", policy: "" }),
  });
  assert.equal(planRes.status, 201, "plan create failed");
  const plan = (await planRes.json()) as { id: string };
  const engRes = await authedFetch(app, auditorCookie, "/api/engagements", {
    method: "POST",
    body: JSON.stringify({ plan_id: plan.id, title: `${department}監査`, scope: "", criteria: "", department, classification: "C2" }),
  });
  assert.equal(engRes.status, 201, "engagement create failed");
  return (await engRes.json()) as { id: string };
}

describe("integration: remediation status transitions", () => {
  test("owner can transition planned→in_progress→submitted; invalid transitions rejected", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");
    const zaimu = await login(app, "zaimu@test.local", "TestPass2026!");

    const eng = await createPlanAndEngagement(app, auditor);
    const fndRes = await authedFetch(app, auditor, `/api/engagements/${eng.id}/findings`, {
      method: "POST",
      body: JSON.stringify({ fact: "承認漏れ", criterion: "決裁規程", severity: "high" }),
    });
    assert.equal(fndRes.status, 201, "finding create failed");
    const fnd = (await fndRes.json()) as { id: string };

    // 被監査部門のユーザーIDを取得
    const meRes = await authedFetch(app, kensetsu, "/api/me");
    const me = (await meRes.json()) as { user: { id: string } };
    const ownerId = me.user.id;

    // 被監査部門が回答 → 監査役が事実確認（確定）→ 是正計画登録（指摘状態の前提）
    const respRes = await authedFetch(app, kensetsu, `/api/findings/${fnd.id}/responses`, {
      method: "POST",
      body: JSON.stringify({ response: "改善します", disagreement: "" }),
    });
    assert.equal(respRes.status, 201, "finding response failed");
    const confRes = await authedFetch(app, auditor, `/api/findings/${fnd.id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ severity: "high" }),
    });
    assert.equal(confRes.status, 200, "finding confirm failed");

    const remRes = await authedFetch(app, kensetsu, `/api/findings/${fnd.id}/remediations`, {
      method: "POST",
      body: JSON.stringify({ action: "是正計画", owner_id: ownerId, due_at: null }),
    });
    assert.equal(remRes.status, 201, "remediation create failed");
    const rem = (await remRes.json()) as { id: string };

    // 不正遷移（planned→submitted 直接）は 409
    const bad = await authedFetch(app, kensetsu, `/api/remediations/${rem.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "submitted" }),
    });
    assert.equal(bad.status, 409);

    // 正規遷移 planned→in_progress→submitted
    assert.equal(
      (await authedFetch(app, kensetsu, `/api/remediations/${rem.id}/status`, { method: "POST", body: JSON.stringify({ status: "in_progress" }) })).status,
      200
    );
    assert.equal(
      (await authedFetch(app, kensetsu, `/api/remediations/${rem.id}/status`, { method: "POST", body: JSON.stringify({ status: "submitted" }) })).status,
      200
    );

    // 責任者でない他部門ユーザー（財務部）は操作不可
    const denied = await authedFetch(app, zaimu, `/api/remediations/${rem.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(denied.status, 403);

    // 監査ログ
    const events = await authedFetch(app, auditor, "/api/audit-events?action=remediation_status");
    const ev = (await events.json()) as { events: Array<{ action: string }> };
    assert.ok(ev.events.length >= 2);
  });
});
