// ユニットテスト — セキュリティモジュール（CSRF・レート制限・状態遷移・ヘッダー）

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assertSameOrigin,
  createRateLimiter,
  SECURITY_HEADERS,
  assertTransition,
  PLAN_TRANSITIONS,
  ENGAGEMENT_TRANSITIONS,
  REQUEST_TRANSITIONS,
  WORKPAPER_TRANSITIONS,
  REMEDIATION_TRANSITIONS,
} from "../../src/security.ts";
import { AppError } from "../../src/errors.ts";

describe("unit: assertSameOrigin (CSRF)", () => {
  test("GET without origin is allowed", () => {
    const req = new Request("https://example.com/api/plans", { method: "GET" });
    assert.doesNotThrow(() => assertSameOrigin(req));
  });

  test("POST with matching origin is allowed", () => {
    const req = new Request("https://example.com/api/plans", {
      method: "POST",
      headers: { origin: "https://example.com" },
    });
    assert.doesNotThrow(() => assertSameOrigin(req));
  });

  test("POST with cross-site origin is rejected (403)", () => {
    const req = new Request("https://example.com/api/plans", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.throws(() => assertSameOrigin(req), (e: unknown) => e instanceof AppError && e.status === 403);
  });

  test("POST with matching referer is allowed", () => {
    const req = new Request("https://example.com/api/plans", {
      method: "POST",
      headers: { referer: "https://example.com/page" },
    });
    assert.doesNotThrow(() => assertSameOrigin(req));
  });

  test("POST without origin/referer is allowed (non-browser client)", () => {
    const req = new Request("https://example.com/api/plans", { method: "POST" });
    assert.doesNotThrow(() => assertSameOrigin(req));
  });

  test("PUT with cross-site origin is rejected", () => {
    const req = new Request("https://example.com/api/plans/1", {
      method: "PUT",
      headers: { origin: "https://evil.example" },
    });
    assert.throws(() => assertSameOrigin(req));
  });
});

describe("unit: createRateLimiter", () => {
  test("allows up to limit then rejects with 429", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 3; i++) assert.doesNotThrow(() => limiter("k", 3, 60_000));
    assert.throws(() => limiter("k", 3, 60_000), (e: unknown) => e instanceof AppError && e.status === 429);
  });

  test("separate keys are independent", () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 5; i++) assert.doesNotThrow(() => limiter("a", 5, 60_000));
    assert.doesNotThrow(() => limiter("b", 5, 60_000));
  });

  test("instances are isolated", () => {
    const a = createRateLimiter();
    const b = createRateLimiter();
    for (let i = 0; i < 5; i++) a("k", 5, 60_000);
    assert.doesNotThrow(() => b("k", 5, 60_000));
  });
});

describe("unit: assertTransition", () => {
  test("valid transition passes", () => {
    assert.doesNotThrow(() => assertTransition(PLAN_TRANSITIONS, "draft", "pending_approval", "計画"));
  });

  test("invalid transition throws 409", () => {
    assert.throws(
      () => assertTransition(PLAN_TRANSITIONS, "approved", "draft", "計画"),
      (e: unknown) => e instanceof AppError && e.status === 409
    );
  });

  test("unknown target state throws", () => {
    assert.throws(() => assertTransition(ENGAGEMENT_TRANSITIONS, "draft", "bogus", "案件"));
  });

  test("closed is terminal for requests except return path", () => {
    assert.throws(() => assertTransition(REQUEST_TRANSITIONS, "closed", "sent", "依頼"));
    assert.doesNotThrow(() => assertTransition(REQUEST_TRANSITIONS, "received", "closed", "依頼"));
  });

  test("workpaper review_requested can be returned or finalized", () => {
    assert.doesNotThrow(() => assertTransition(WORKPAPER_TRANSITIONS, "review_requested", "final", "調書"));
    assert.doesNotThrow(() => assertTransition(WORKPAPER_TRANSITIONS, "review_requested", "returned", "調書"));
    assert.throws(() => assertTransition(WORKPAPER_TRANSITIONS, "final", "draft", "調書"));
  });

  test("remediation transitions planned -> in_progress -> submitted", () => {
    assert.doesNotThrow(() => assertTransition(REMEDIATION_TRANSITIONS, "planned", "in_progress", "是正"));
    assert.doesNotThrow(() => assertTransition(REMEDIATION_TRANSITIONS, "in_progress", "submitted", "是正"));
    assert.doesNotThrow(() => assertTransition(REMEDIATION_TRANSITIONS, "submitted", "in_progress", "是正"));
    assert.throws(() => assertTransition(REMEDIATION_TRANSITIONS, "planned", "submitted", "是正"));
    assert.throws(() => assertTransition(REMEDIATION_TRANSITIONS, "completed", "in_progress", "是正"));
  });
});

describe("unit: SECURITY_HEADERS", () => {
  test("contains critical headers", () => {
    assert.ok(SECURITY_HEADERS["X-Content-Type-Options"] === "nosniff");
    assert.ok(SECURITY_HEADERS["X-Frame-Options"] === "DENY");
    assert.ok(SECURITY_HEADERS["Referrer-Policy"] === "no-referrer");
    assert.ok(SECURITY_HEADERS["Content-Security-Policy"]!.includes("frame-ancestors 'none'"));
    assert.ok(SECURITY_HEADERS["Strict-Transport-Security"]!.startsWith("max-age="));
    assert.ok(SECURITY_HEADERS["Cache-Control"] === "no-store");
  });
});
