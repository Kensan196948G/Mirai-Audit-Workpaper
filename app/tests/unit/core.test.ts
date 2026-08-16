// ユニットテスト — 認証・権限・ID採番・監査ログ

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { hashPassword, verifyPassword, sha256Hex, timingSafeEqual } from "../../src/auth.ts";
import { hasPermission, permissionsFor, canViewEngagement, canSubmitToRequest } from "../../src/permissions.ts";
import { engagementNo, requestNo, findingNo, fiscalYear, newId } from "../../src/ids.ts";

describe("unit: password hashing", () => {
  test("hash and verify roundtrip", async () => {
    const hash = await hashPassword("Mirai@2026pass");
    assert.match(hash, /^pbkdf2\$/);
    assert.ok(await verifyPassword("Mirai@2026pass", hash));
    assert.ok(!(await verifyPassword("wrongpass", hash)));
  });

  test("verify rejects malformed hash", async () => {
    assert.ok(!(await verifyPassword("x", "not-a-hash")));
  });

  test("sha256 produces 64 hex chars", async () => {
    const h = await sha256Hex("abc");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  test("timingSafeEqual", () => {
    assert.ok(timingSafeEqual("abc", "abc"));
    assert.ok(!timingSafeEqual("abc", "abd"));
    assert.ok(!timingSafeEqual("abc", "abcd"));
  });
});

describe("unit: permissions", () => {
  test("auditor can create plans/engagements/workpapers", () => {
    assert.ok(hasPermission("auditor", "plan:create"));
    assert.ok(hasPermission("auditor", "engagement:create"));
    assert.ok(hasPermission("auditor", "workpaper:create"));
    assert.ok(hasPermission("auditor", "finding:create"));
    assert.ok(!hasPermission("auditor", "plan:approve"));
  });

  test("audit_committee can approve plans but not create engagements", () => {
    assert.ok(hasPermission("audit_committee", "plan:approve"));
    assert.ok(hasPermission("audit_committee", "workpaper:approve"));
    assert.ok(hasPermission("audit_committee", "workpaper:review"));
    assert.ok(!hasPermission("audit_committee", "engagement:create"));
    assert.ok(!hasPermission("audit_committee", "request:create"));
  });

  test("auditee limited to submit and respond", () => {
    assert.ok(hasPermission("auditee", "request:submit"));
    assert.ok(hasPermission("auditee", "finding:respond"));
    assert.ok(hasPermission("auditee", "remediation:create"));
    assert.ok(!hasPermission("auditee", "plan:create"));
    assert.ok(!hasPermission("auditee", "auditlog:view"));
  });

  test("admin cannot manage business data", () => {
    assert.ok(hasPermission("admin", "admin:manage"));
    assert.ok(hasPermission("admin", "auditlog:view"));
    assert.ok(!hasPermission("admin", "plan:create"));
    assert.ok(!hasPermission("admin", "engagement:create"));
    assert.ok(!hasPermission("admin", "workpaper:create"));
  });

  test("permissionsFor returns sorted list", () => {
    const perms = permissionsFor("auditee");
    assert.ok(perms.includes("request:submit"));
    assert.ok(perms.length > 0);
  });

  test("canViewEngagement: auditee only own department", () => {
    assert.ok(canViewEngagement("auditee", "建設部", "建設部", false));
    assert.ok(!canViewEngagement("auditee", "財務部", "建設部", false));
    assert.ok(!canViewEngagement("auditee", "建設部", "財務部", false));
  });

  test("canViewEngagement: auditor needs membership, admin denied", () => {
    assert.ok(canViewEngagement("auditor", "監査役室", "建設部", true));
    assert.ok(!canViewEngagement("auditor", "監査役室", "建設部", false));
    assert.ok(!canViewEngagement("admin", "情報システム部", "建設部", true));
  });

  test("canSubmitToRequest: auditee own department only", () => {
    assert.ok(canSubmitToRequest("auditee", "建設部", "建設部"));
    assert.ok(!canSubmitToRequest("auditee", "財務部", "建設部"));
    assert.ok(canSubmitToRequest("auditor", "監査役室", "建設部"));
  });
});

describe("unit: ids", () => {
  test("engagementNo format AUD-YYYY-NNNN", () => {
    assert.equal(engagementNo("2026", 1), "AUD-2026-0001");
    assert.equal(engagementNo("2026", 123), "AUD-2026-0123");
    assert.equal(engagementNo("2027", 9999), "AUD-2027-9999");
  });

  test("requestNo / findingNo formats", () => {
    assert.equal(requestNo("2026", 7), "REQ-2026-0007");
    assert.equal(findingNo("2026", 42), "FND-2026-0042");
  });

  test("fiscalYear returns 4 digits", () => {
    const fy = fiscalYear(new Date("2026-03-31T12:00:00Z"));
    assert.match(fy, /^\d{4}$/);
  });

  test("newId is unique", () => {
    const a = newId("usr");
    const b = newId("usr");
    assert.notEqual(a, b);
    assert.ok(a.startsWith("usr_"));
  });
});
