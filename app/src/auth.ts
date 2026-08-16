// 認証・パスワードハッシュ（Web Crypto API / PBKDF2-SHA256）
// 詳細仕様設計書 7.1: 認可判定（在籍 AND ロール AND 案件メンバー AND 機密区分 AND 利益相反なし）

const ITERATIONS = 90_000; // workerdのPBKDF2上限100,000未満
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** パスワードハッシュ生成: pbkdf2$iterations$salt$hash */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    key,
    KEY_BYTES * 8
  );
  return `pbkdf2$${ITERATIONS}$${bufToB64(salt.buffer)}$${bufToB64(bits)}`;
}

/** パスワード検証 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split("$");
    if (scheme !== "pbkdf2" || !iterStr || !saltB64 || !hashB64) return false;
    const iterations = Number(iterStr);
    const salt = b64ToBuf(saltB64);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations },
      key,
      KEY_BYTES * 8
    );
    return bufToB64(bits) === hashB64;
  } catch {
    return false;
  }
}

/** SHA-256 ハッシュ（証憑・調書の完全性） */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** セッショントークン生成 */
export function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定時比較（タイミング攻撃対策） */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
