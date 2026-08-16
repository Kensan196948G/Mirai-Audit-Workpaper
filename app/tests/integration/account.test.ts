// 統合テスト — ユーザー一覧・パスワード変更・タスク導線情報
// - GET /api/users: 指摘作成権限者（監査役）と管理者のみ閲覧可（WebUI改修 F-07/F-06 対応）
// - POST /api/auth/password: 現在パスワード検証・複雑性・変更後の旧パスワード無効化（F-09 対応）
// - GET /api/me: タスクに engagement_id を含む（F-02 タスク導線対応）

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildApp, type AppDeps } from "../../src/app.ts";
import { createTestDb, type TestUserSeed } from "./helpers.ts";

const USERS: TestUserSeed[] = [
  { email: "admin@test.local", name: "管理者", role: "admin", department: "情報システム部", password: "TestPass2026!" },
  { email: "auditor@test.local", name: "監査役", role: "auditor", department: "監査役室", password: "TestPass2026!" },
  { email: "committee@test.local", name: "監査役会", role: "audit_committee", department: "監査役会", password: "TestPass2026!" },
  { email: "kensetsu@test.local", name: "建設部", role: "auditee", department: "建設部", password: "TestPass2026!" },
];

async function buildTestApp() {
  const db = await createTestDb(USERS);
  const deps: AppDeps = { db, environment: "test", getClientIp: () => "203.0.113.60" };
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

describe("integration: /api/users", () => {
  test("auditor and admin can list users; committee/auditee denied", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const admin = await login(app, "admin@test.local", "TestPass2026!");
    const committee = await login(app, "committee@test.local", "TestPass2026!");
    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");

    const r1 = await authedFetch(app, auditor, "/api/users");
    assert.equal(r1.status, 200);
    const body = (await r1.json()) as { users: Array<{ id: string; name: string; department: string }> };
    assert.ok(body.users.length >= 4);
    assert.ok(body.users.some((u) => u.name === "建設部"));

    const r2 = await authedFetch(app, admin, "/api/users");
    assert.equal(r2.status, 200);

    const r3 = await authedFetch(app, committee, "/api/users");
    assert.equal(r3.status, 403);

    const r4 = await authedFetch(app, kensetsu, "/api/users");
    assert.equal(r4.status, 403);
  });
});

describe("integration: /api/auth/password", () => {
  test("wrong current password and weak new password are rejected; change works", async () => {
    const app = await buildTestApp();
    const cookie = await login(app, "auditor@test.local", "TestPass2026!");

    // 現在パスワード誤り → 400
    const bad = await authedFetch(app, cookie, "/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: "wrong-pass", new_password: "NewPass2026!" }),
    });
    assert.equal(bad.status, 400);

    // 複雑性不足（数字なし）→ 400
    const weak = await authedFetch(app, cookie, "/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: "TestPass2026!", new_password: "abcdefghij" }),
    });
    assert.equal(weak.status, 400);

    // 成功
    const ok = await authedFetch(app, cookie, "/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: "TestPass2026!", new_password: "NewPass2026!" }),
    });
    assert.equal(ok.status, 200);

    // 旧パスワードで再ログイン不可・新パスワードで可
    const oldLogin = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "TestPass2026!" }),
      })
    );
    assert.equal(oldLogin.status, 401);
    const newLogin = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "NewPass2026!" }),
      })
    );
    assert.equal(newLogin.status, 200);

    // 監査ログに記録される
    const events = await authedFetch(app, cookie, "/api/audit-events?action=password_changed");
    assert.equal(events.status, 200);
    const ev = (await events.json()) as { events: Array<{ action: string }> };
    assert.ok(ev.events.some((e) => e.action === "password_changed"));
  });
});

describe("integration: /api/me task navigation info (F-02)", () => {
  test("request task includes engagement_id for auditee", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const planRes = await authedFetch(app, auditor, "/api/plans", {
      method: "POST",
      body: JSON.stringify({ fiscal_year: "2026", title: "計画", policy: "" }),
    });
    const plan = (await planRes.json()) as { id: string };
    const engRes = await authedFetch(app, auditor, "/api/engagements", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, title: "建設部監査", scope: "", criteria: "", department: "建設部", classification: "C2" }),
    });
    const eng = (await engRes.json()) as { id: string };
    await authedFetch(app, auditor, `/api/engagements/${eng.id}/requests`, {
      method: "POST",
      body: JSON.stringify({ recipient_department: "建設部", item: "契約書", purpose: "", due_at: null }),
    });

    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");
    const me = await authedFetch(app, kensetsu, "/api/me");
    assert.equal(me.status, 200);
    const body = (await me.json()) as { tasks: Array<{ type: string; engagement_id?: string }> };
    const reqTask = body.tasks.find((t) => t.type === "request");
    assert.ok(reqTask, "request task should exist");
    assert.equal(reqTask.engagement_id, eng.id);
  });
});
