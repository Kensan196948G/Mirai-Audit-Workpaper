// 統合テスト — セキュリティ・状態遷移・依頼フロー
// - CSRF: クロスサイト Origin の状態変更を拒否
// - Cookie: HTTPS 環境で Secure 属性が付与される
// - レート制限: ログイン連続失敗で 429
// - 状態遷移: 不正遷移を拒否、計画却下、依頼 受領/差戻し/締切、調書差戻し
// - bootstrap: 本番環境で拒否

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
];

async function buildTestApp(environment = "test", ip = "198.51.100.7") {
  const db = await createTestDb(USERS);
  const deps: AppDeps = {
    db,
    environment,
    getClientIp: () => ip,
  };
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
  const cookie = res.headers.get("set-cookie") ?? "";
  return cookie.split(";")[0]!;
}

async function authedFetch(app: any, cookie: string, path: string, init: RequestInit = {}, extraHeaders: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...extraHeaders, ...(init.headers ?? {}) },
    })
  );
}

describe("integration: security", () => {
  test("security headers are present on all responses", async () => {
    const app = await buildTestApp();
    const res = await app.fetch(new Request("http://localhost/api/health"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.ok(res.headers.get("content-security-policy")?.includes("default-src 'self'"));
  });

  test("cross-site origin on state-changing request is rejected (CSRF)", async () => {
    const app = await buildTestApp();
    const cookie = await login(app, "auditor@test.local", "TestPass2026!");
    const res = await authedFetch(app, cookie, "/api/plans", {
      method: "POST",
      body: JSON.stringify({ fiscal_year: "2026", title: "X", policy: "" }),
    }, { origin: "https://evil.example" });
    assert.equal(res.status, 403);
  });

  test("same-origin POST is allowed", async () => {
    const app = await buildTestApp();
    const cookie = await login(app, "auditor@test.local", "TestPass2026!");
    const res = await authedFetch(app, cookie, "/api/plans", {
      method: "POST",
      body: JSON.stringify({ fiscal_year: "2026", title: "2026年度監査", policy: "" }),
    }, { origin: "http://localhost" });
    assert.equal(res.status, 201);
  });

  test("https login cookie has Secure attribute", async () => {
    const app = await buildTestApp();
    const res = await app.fetch(
      new Request("https://example.com/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "TestPass2026!" }),
      })
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Lax"));
    assert.ok(cookie.includes("Secure"));
  });

  test("http localhost login cookie has no Secure attribute (dev)", async () => {
    const app = await buildTestApp();
    const res = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "TestPass2026!" }),
      })
    );
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.ok(!cookie.includes("Secure"));
  });

  test("login rate limit returns 429 after repeated failures", async () => {
    const app = await buildTestApp();
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "auditor@test.local", password: "WrongPass123" }),
        })
      );
      assert.equal(res.status, 401);
    }
    const limited = await app.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "auditor@test.local", password: "WrongPass123" }),
      })
    );
    assert.equal(limited.status, 429);
  });

  test("bootstrap is rejected in production environment", async () => {
    const app = await buildTestApp("production");
    const res = await app.fetch(
      new Request("http://localhost/api/admin/bootstrap", { method: "POST" })
    );
    assert.equal(res.status, 403);
  });

  test("bootstrap works in preview when BOOTSTRAP_PASSWORD set and DB empty", async () => {
    // 空のDBを用意（ユーザーなし）
    const { DatabaseSync } = await import("node:sqlite");
    const { applySchema } = await import("./helpers.ts");
    const dbRaw = new DatabaseSync(":memory:");
    applySchema(dbRaw);
    const { SyncDb } = await import("./helpers.ts");
    const { buildApp: build } = await import("../../src/app.ts");
    const app = build({ db: new SyncDb(dbRaw), environment: "preview", bootstrapPassword: "TestBootstrap2026!", getClientIp: () => "198.51.100.7" });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/bootstrap", { method: "POST" })
    );
    assert.equal(res.status, 200);
  });

  test("bootstrap without BOOTSTRAP_PASSWORD is rejected in preview", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { applySchema } = await import("./helpers.ts");
    const dbRaw = new DatabaseSync(":memory:");
    applySchema(dbRaw);
    const { SyncDb } = await import("./helpers.ts");
    const { buildApp: build } = await import("../../src/app.ts");
    const app = build({ db: new SyncDb(dbRaw), environment: "preview", getClientIp: () => "198.51.100.7" });
    const res = await app.fetch(
      new Request("http://localhost/api/admin/bootstrap", { method: "POST" })
    );
    assert.equal(res.status, 403);
  });
});

describe("integration: status transitions", () => {
  async function setupPlan(app: any, cookie: string) {
    const res = await authedFetch(app, cookie, "/api/plans", {
      method: "POST",
      body: JSON.stringify({ fiscal_year: "2026", title: "2026年度監査", policy: "" }),
    });
    assert.equal(res.status, 201);
    return (await res.json()) as { id: string };
  }

  test("plan approve from draft is rejected; reject flow works", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const committee = await login(app, "committee@test.local", "TestPass2026!");
    const plan = await setupPlan(app, auditor);

    // draft のまま承認 → 409
    const badApprove = await authedFetch(app, committee, `/api/plans/${plan.id}/approve`, { method: "POST" });
    assert.equal(badApprove.status, 409);

    // 承認申請 → 却下 → 再申請 → 承認
    assert.equal((await authedFetch(app, auditor, `/api/plans/${plan.id}/submit`, { method: "POST" })).status, 200);
    assert.equal((await authedFetch(app, committee, `/api/plans/${plan.id}/reject`, { method: "POST" })).status, 200);
    assert.equal((await authedFetch(app, auditor, `/api/plans/${plan.id}/submit`, { method: "POST" })).status, 200);
    assert.equal((await authedFetch(app, committee, `/api/plans/${plan.id}/approve`, { method: "POST" })).status, 200);

    // 承認済み計画への更新 → 409（承認済みは変更不可）
    const upd = await authedFetch(app, auditor, `/api/plans/${plan.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "変更", fiscal_year: "2026" }),
    });
    assert.equal(upd.status, 409);
  });

  test("engagement invalid transition is rejected", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const plan = await setupPlan(app, auditor);
    const engRes = await authedFetch(app, auditor, "/api/engagements", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, title: "建設部監査", scope: "", criteria: "", department: "建設部", classification: "C2" }),
    });
    const eng = (await engRes.json()) as { id: string };

    // draft → reported は不正遷移 → 409
    const bad = await authedFetch(app, auditor, `/api/engagements/${eng.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "reported" }),
    });
    assert.equal(bad.status, 409);

    // draft → in_progress は正しい遷移
    const ok = await authedFetch(app, auditor, `/api/engagements/${eng.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: "in_progress" }),
    });
    assert.equal(ok.status, 200);
  });

  test("request flow: send -> partial -> receive -> close, return on received", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const kensetsu = await login(app, "kensetsu@test.local", "TestPass2026!");
    const plan = await setupPlan(app, auditor);
    const engRes = await authedFetch(app, auditor, "/api/engagements", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, title: "建設部監査", scope: "", criteria: "", department: "建設部", classification: "C2" }),
    });
    const eng = (await engRes.json()) as { id: string };
    const reqRes = await authedFetch(app, auditor, `/api/engagements/${eng.id}/requests`, {
      method: "POST",
      body: JSON.stringify({ recipient_department: "建設部", item: "契約書一覧", purpose: "", due_at: null }),
    });
    const req = (await reqRes.json()) as { id: string };

    // draft → sent
    assert.equal((await authedFetch(app, auditor, `/api/requests/${req.id}/send`, { method: "POST" })).status, 200);

    // 被監査部門が提出 → partial
    const sub = await authedFetch(app, kensetsu, `/api/requests/${req.id}/submissions`, {
      method: "POST",
      body: JSON.stringify({ file_name: "a.pdf", content_hash: "h1", note: "" }),
    });
    assert.equal(sub.status, 201);
    const detail = await authedFetch(app, auditor, `/api/engagements/${eng.id}/requests`);
    const body = (await detail.json()) as { requests: Array<{ id: string; status: string }> };
    assert.equal(body.requests.find((r) => r.id === req.id)?.status, "partial");

    // receive → received
    assert.equal((await authedFetch(app, auditor, `/api/requests/${req.id}/receive`, { method: "POST" })).status, 200);

    // closed 依頼への提出は拒否
    assert.equal((await authedFetch(app, auditor, `/api/requests/${req.id}/close`, { method: "POST" })).status, 200);
    const denied = await authedFetch(app, kensetsu, `/api/requests/${req.id}/submissions`, {
      method: "POST",
      body: JSON.stringify({ file_name: "b.pdf", content_hash: "h2", note: "" }),
    });
    assert.equal(denied.status, 409);
  });

  test("workpaper return by reviewer resets to returned", async () => {
    const app = await buildTestApp();
    const auditor = await login(app, "auditor@test.local", "TestPass2026!");
    const committee = await login(app, "committee@test.local", "TestPass2026!");
    const plan = await setupPlan(app, auditor);
    const engRes = await authedFetch(app, auditor, "/api/engagements", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, title: "建設部監査", scope: "", criteria: "", department: "建設部", classification: "C2" }),
    });
    const eng = (await engRes.json()) as { id: string };

    // committee のIDを取得（reviewerに設定するため）— /api/me から取得
    const meRes = await authedFetch(app, committee, "/api/me");
    const me = (await meRes.json()) as { user: { id: string } };

    const wpRes = await authedFetch(app, auditor, `/api/engagements/${eng.id}/workpapers`, {
      method: "POST",
      body: JSON.stringify({ code: "WP-1", title: "調書", body: "内容", conclusion: "", reviewer_id: me.user.id }),
    });
    const wp = (await wpRes.json()) as { id: string };
    assert.equal((await authedFetch(app, auditor, `/api/workpapers/${wp.id}/review`, { method: "POST" })).status, 200);
    // レビュー者（committee）が差戻し
    assert.equal((await authedFetch(app, committee, `/api/workpapers/${wp.id}/return`, { method: "POST" })).status, 200);
    const detail = await authedFetch(app, auditor, `/api/engagements/${eng.id}/workpapers`);
    const body = (await detail.json()) as { workpapers: Array<{ id: string; status: string }> };
    assert.equal(body.workpapers.find((w) => w.id === wp.id)?.status, "returned");
    // 再レビュー依頼 → 確定
    assert.equal((await authedFetch(app, auditor, `/api/workpapers/${wp.id}/review`, { method: "POST" })).status, 200);
    assert.equal((await authedFetch(app, committee, `/api/workpapers/${wp.id}/approve`, { method: "POST" })).status, 200);
  });
});
