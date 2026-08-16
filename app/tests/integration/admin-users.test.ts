// 統合テスト — 管理者ユーザー管理（BL-09 垂直スライス / UAT-08 支援）
// - GET/POST /api/admin/users: 管理者のみ・作成・一覧
// - deactivate / activate: 退職・異動相当の権限剥奪・復帰、セッション無効化
// - password リセット: 管理者による再設定、既存セッション無効化
// - 監査ログ: user_created / user_deactivated / user_activated / user_password_reset を記録

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildApp, type AppDeps } from "../../src/app.ts";
import { createTestDb, type TestUserSeed } from "./helpers.ts";

const USERS: TestUserSeed[] = [
  { email: "admin@test.local", name: "管理者", role: "admin", department: "情報システム部", password: "TestPass2026!" },
  { email: "auditor@test.local", name: "監査役", role: "auditor", department: "監査役室", password: "TestPass2026!" },
  { email: "kensetsu@test.local", name: "建設部", role: "auditee", department: "建設部", password: "TestPass2026!" },
];

async function buildTestApp() {
  const db = await createTestDb(USERS);
  const deps: AppDeps = { db, environment: "test", getClientIp: () => "203.0.113.70" };
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

describe("integration: admin user management", () => {
  test("admin can create/list users; other roles are denied", async () => {
    const app = await buildTestApp();
    const admin = await login(app, "admin@test.local", "TestPass2026!");
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");

    // 権限なし（監査役）は拒否
    assert.equal((await authedFetch(app, auditor, "/api/admin/users")).status, 403);

    // 作成
    const created = await authedFetch(app, admin, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: "new-auditor@test.local",
        name: "新任監査役",
        role: "auditor",
        department: "監査役室",
        password: "NewPass2026!",
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { id: string };

    // 一覧に含まれる（active=1）
    const list = await authedFetch(app, admin, "/api/admin/users");
    assert.equal(list.status, 200);
    const body = (await list.json()) as { users: Array<{ id: string; email: string; active: number }> };
    const found = body.users.find((u) => u.id === createdBody.id);
    assert.ok(found, "created user should appear in list");
    assert.equal(found!.email, "new-auditor@test.local");
    assert.equal(found!.active, 1);

    // 重複メールは 409
    const dup = await authedFetch(app, admin, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({
        email: "NEW-AUDITOR@test.local",
        name: "重複",
        role: "auditor",
        department: "監査役室",
        password: "NewPass2026!",
      }),
    });
    assert.equal(dup.status, 409);

    // 不正入力（パスワード弱・ロール不正）は 400
    const weak = await authedFetch(app, admin, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: "x@test.local", name: "X", role: "auditor", department: "D", password: "short" }),
    });
    assert.equal(weak.status, 400);
    const badRole = await authedFetch(app, admin, "/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: "y@test.local", name: "Y", role: "superuser", department: "D", password: "NewPass2026!" }),
    });
    assert.equal(badRole.status, 400);

    // 監査ログ
    const events = await authedFetch(app, admin, "/api/audit-events?action=user_created");
    const ev = (await events.json()) as { events: Array<{ action: string; detail: string }> };
    assert.ok(ev.events.some((e) => e.action === "user_created" && e.detail === "new-auditor@test.local"));
  });

  test("deactivation blocks login and invalidates existing sessions (UAT-08)", async () => {
    const app = await buildTestApp();
    const admin = await login(app, "admin@test.local", "TestPass2026!");
    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");

    // 無効化前に自部門ユーザーとしてアクセス可
    assert.equal((await authedFetch(app, kensetsu, "/api/me")).status, 200);

    // 対象ユーザーIDを管理者一覧から取得
    const list = await authedFetch(app, admin, "/api/admin/users");
    const users = (await list.json()) as { users: Array<{ id: string; email: string }> };
    const target = users.users.find((u) => u.email === "kensetsu@test.local")!;
    assert.ok(target, "target user should exist");

    const deact = await authedFetch(app, admin, `/api/admin/users/${target.id}/deactivate`, { method: "POST" });
    assert.equal(deact.status, 200);

    // 既存セッションが無効化される（401）
    assert.equal((await authedFetch(app, kensetsu, "/api/me")).status, 401);
    // ログインも拒否（active=0）
    const relogin = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "kensetsu@test.local", password: "TestPass2026!" }),
      })
    );
    assert.equal(relogin.status, 401);

    // 管理者自身の無効化は 409
    const self = (await (await authedFetch(app, admin, "/api/admin/users")).json()) as {
      users: Array<{ id: string; email: string }>;
    };
    const adminId = self.users.find((u) => u.email === "admin@test.local")!.id;
    assert.equal((await authedFetch(app, admin, `/api/admin/users/${adminId}/deactivate`, { method: "POST" })).status, 409);
  });

  test("reactivation and admin password reset work with audit trail", async () => {
    const app = await buildTestApp();
    const admin = await login(app, "admin@test.local", "TestPass2026!");
    const listRes = await authedFetch(app, admin, "/api/admin/users");
    const list = (await listRes.json()) as { users: Array<{ id: string; email: string }> };
    const target = list.users.find((u) => u.email === "auditor@test.local")!;

    await authedFetch(app, admin, `/api/admin/users/${target.id}/deactivate`, { method: "POST" });
    const activate = await authedFetch(app, admin, `/api/admin/users/${target.id}/activate`, { method: "POST" });
    assert.equal(activate.status, 200);

    // パスワード再設定
    const reset = await authedFetch(app, admin, `/api/admin/users/${target.id}/password`, {
      method: "POST",
      body: JSON.stringify({ new_password: "ResetPass2026!" }),
    });
    assert.equal(reset.status, 200);

    // 新パスワードでログイン可・旧パスワード不可
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
        body: JSON.stringify({ email: "auditor@test.local", password: "ResetPass2026!" }),
      })
    );
    assert.equal(newLogin.status, 200);

    // 監査ログ
    const events = await authedFetch(app, admin, "/api/audit-events?action=user_password_reset");
    const ev = (await events.json()) as { events: Array<{ action: string }> };
    assert.ok(ev.events.some((e) => e.action === "user_password_reset"));
  });

  test("admin can update name/role/department/active via PUT", async () => {
    const app = await buildTestApp();
    const admin = await login(app, "admin@test.local", "TestPass2026!");
    const listRes = await authedFetch(app, admin, "/api/admin/users");
    const list = (await listRes.json()) as { users: Array<{ id: string; email: string; role: string; department: string; active: number }> };
    const target = list.users.find((u) => u.email === "auditor@test.local")!;

    const upd = await authedFetch(app, admin, `/api/admin/users/${target.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: "監査役（改名）", role: "auditor", department: "監査役会", active: true }),
    });
    assert.equal(upd.status, 200);

    const after = await authedFetch(app, admin, "/api/admin/users");
    const users = (await after.json()) as { users: Array<{ id: string; name: string; department: string; active: number }> };
    const updated = users.users.find((u) => u.id === target.id)!;
    assert.equal(updated.name, "監査役（改名）");
    assert.equal(updated.department, "監査役会");
    assert.equal(updated.active, 1);

    // 更新項目なしは 400
    const empty = await authedFetch(app, admin, `/api/admin/users/${target.id}`, { method: "PUT", body: JSON.stringify({}) });
    assert.equal(empty.status, 400);

    // 監査ログ
    const events = await authedFetch(app, admin, "/api/audit-events?action=user_updated");
    const ev = (await events.json()) as { events: Array<{ action: string }> };
    assert.ok(ev.events.some((e) => e.action === "user_updated"));
  });
});
