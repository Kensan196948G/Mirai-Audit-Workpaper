// 統合テスト — デプロイ環境による配信WebUIの出し分け（CHG-040）
// 本番環境のみ本番用WebUI（index.production.html）を配信し、preview/MVPは通常UIを配信する

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { buildApp, type AppDeps } from "../../src/app.ts";
import { createTestDb, type TestUserSeed } from "./helpers.ts";

const USERS: TestUserSeed[] = [
  { email: "admin@test.local", name: "管理者", role: "admin", department: "情報システム部", password: "TestPass2026!" },
];

async function buildTestApp(environment: string) {
  const db = await createTestDb(USERS);
  const deps: AppDeps = {
    db,
    environment,
    getClientIp: () => "203.0.113.10",
  };
  return buildApp(deps);
}

async function getRootHtml(app: any): Promise<string> {
  const res = await app.fetch(new Request("http://localhost/"));
  assert.equal(res.status, 200);
  const contentType = res.headers.get("content-type") ?? "";
  assert.ok(contentType.includes("text/html"), `expected text/html, got ${contentType}`);
  return await res.text();
}

describe("UI環境出し分け（本番用WebUI）", () => {
  test("production 環境では本番用UIを配信する（デモ欄・MVP注記なし）", async () => {
    const app = await buildTestApp("production");
    const html = await getRootHtml(app);
    assert.ok(html.includes('name="maw-ui" content="production"'), "本番用UIのマーカーがあること");
    assert.ok(
      !html.includes("テスト環境です。デモ用IDを選択してメールを入力できます。"),
      "テスト環境向けログイン文言がないこと",
    );
    assert.ok(!html.includes("現行MVPはファイルの実アップロード未対応"), "MVP暫定注記がないこと");
  });

  test("preview 環境では通常UIを配信する（デモ欄・MVP注記あり）", async () => {
    const app = await buildTestApp("preview");
    const html = await getRootHtml(app);
    assert.ok(!html.includes('name="maw-ui" content="production"'), "本番用UIのマーカーがないこと");
    assert.ok(
      html.includes("テスト環境です。デモ用IDを選択してメールを入力できます。"),
      "テスト環境向けログイン文言があること",
    );
    assert.ok(html.includes("現行MVPはファイルの実アップロード未対応"), "MVP暫定注記があること");
  });

  test("mvp 環境でも通常UIを配信する", async () => {
    const app = await buildTestApp("mvp");
    const html = await getRootHtml(app);
    assert.ok(!html.includes('name="maw-ui" content="production"'), "本番用UIのマーカーがないこと");
  });
});
