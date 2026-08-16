// シードスクリプト — ローカルD1への初期データ投入（ダミー・テストデータのみ）
// 使用方法: node scripts/seed.mjs [--local|--remote]

const mode = process.argv.includes("--remote") ? "remote" : "local";

const users = [
  { email: "admin@mirai.local", name: "システム管理者", role: "admin", department: "情報システム部" },
  { email: "auditor@mirai.local", name: "監査役 山田", role: "auditor", department: "監査役室" },
  { email: "committee@mirai.local", name: "監査役会 佐藤", role: "audit_committee", department: "監査役会" },
  { email: "ga@mirai.local", name: "総務部 鈴木", role: "general_affairs", department: "総務部" },
  { email: "kensetsu@mirai.local", name: "建設部 田中", role: "auditee", department: "建設部" },
  { email: "zaimu@mirai.local", name: "財務部 高橋", role: "auditee", department: "財務部" },
];

// パスワードは Web Crypto で PBKDF2 ハッシュ化（アプリのauth.tsと同じ方式: 90,000回）
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 90000 }, key, 256);
  const b64 = (buf) => Buffer.from(buf).toString("base64");
  return `pbkdf2$90000$${b64(salt.buffer)}$${b64(bits)}`;
}

const PASSWORD = "Mirai@2026pass";

async function main() {
  const hash = await hashPassword(PASSWORD);
  const ts = new Date().toISOString();
  const rows = users.map((u) => {
    const id = `usr_seed_${u.email.split("@")[0]}`;
    return `('${id}', '${u.email}', '${u.name}', '${u.role}', '${u.department}', 1, '${hash}', '${ts}', '${ts}')`;
  });
  const sql = `INSERT OR IGNORE INTO users (id, email, name, role, department, active, password_hash, created_at, updated_at) VALUES\n${rows.join(",\n")};`;
  const fs = await import("node:fs");
  fs.writeFileSync(new URL("./seed-users.sql", import.meta.url), sql);
  console.log(`seed SQL generated: ${users.length} users (password: ${PASSWORD})`);
  console.log(`apply with: npx wrangler d1 execute mirai-audit-workpaper-db --${mode} --file scripts/seed-users.sql`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});