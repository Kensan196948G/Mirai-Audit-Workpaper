// ユニットテスト — シード（seed.mjs）のパスワードハッシュ形式（P1-8 回帰）
// seed.mjs が生成するハッシュは pbkdf2$<iter>$<salt>$<hash> 形式でなければ、
// verifyPassword が常に false となりシードユーザーはログイン不能になる。

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPassword } from "../../src/auth.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("unit: seed hash format (P1-8 regression)", () => {
  test("seed.mjs template contains dollar separators", () => {
    const src = readFileSync(join(here, "..", "..", "scripts", "seed.mjs"), "utf8");
    assert.ok(src.includes("pbkdf2$90000$${b64(salt.buffer)}$${b64(bits)}"), "seed.mjs のハッシュ形式に $ 区切りが必要");
  });

  test("seed-style hash with separators is accepted by verifyPassword", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("Mirai@2026pass"), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 90000 }, key, 256);
    const b64 = (buf: ArrayBuffer) => Buffer.from(buf).toString("base64");
    const hash = `pbkdf2$90000$${b64(salt.buffer)}$${b64(bits)}`;
    assert.equal(hash.split("$").length, 4);
    assert.ok(await verifyPassword("Mirai@2026pass", hash));
  });
});
