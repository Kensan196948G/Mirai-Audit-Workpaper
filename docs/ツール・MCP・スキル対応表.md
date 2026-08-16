# ツール・MCP・スキル目的別対応表

本プロジェクト（Mirai Audit Workpaper）で利用可能なツール群と、その適用判断を記録する。
文書の精査・検証・管理に加え、app/ 実装（Cloudflare Workers + D1）の開発・デプロイ・運用にも適用する。

## 1. MCP / 外部サービス

| ツール | 目的 | 認証・権限 | 読書き | 本プロジェクトでの適用 | 適用判断の根拠 |
|---|---|---|---|---|---|
| filesystem | ファイル・文書の読み書き、検証 | セッション許可ディレクトリ | 読書可 | ✅ 使用 | 文書群の精査・更新・リンク検証に必須 |
| bash | スクリプト実行（リンク検証・HTML構造検証・テスト） | セッションサンドボックス | 実行 | ✅ 使用 | check-links.py・app のビルド/テスト/デプロイ検証 |
| web_search | 一般情報の参照 | — | 読 | ⚪ 状況による | 製品候補（AppSuite等）の仕様確認時のみ |
| GitHub CLI（gh） | リポジトリ・PR・Actions・secrets 管理 | 要認証（トークン） | 読書 | ✅ 使用 | GitHub リポジトリ作成、PR#1〜5 作成・マージ、CI 確認、secrets 設定（CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN）、default branch を main に修正、workflow run 確認 |
| Cloudflare MCP | Workers/D1/ゾーン/DNS の確認 | 要アカウント（アカウントスコープのAPIトークン） | 読書（トークン作成等の User API Tokens 操作は権限外で不可） | ✅ 使用 | Worker・D1・ゾーン・カスタムドメインの実在確認、デプロイ状況・ルート確認、トークンverify（作成・一覧は9109で不可のため CI 用トークンは既存トークンを流用しローテーションを推奨記録）。デプロイ本体は CI（GitHub Actions）が実施 |
| Neon MCP | Postgres DB管理 | 要アカウント | 読書 | 🔴 未使用 | 本プロジェクトは Cloudflare D1 を使用（Postgres 対象なし） |

## 2. スキル

| スキル | 適用 | 判断 |
|---|---|---|
| AutoDesign / autodesign-run（WebUIデザイン生成系） | 🔴 利用不可 | 2026-08-16 セッションのスキルカタログに未登録（invalid skill name）で呼び出し失敗。WebUI（app/web/index.html）は同等のプロフェッショナルデザイン手法（デザイントークン・WCAG 2.1 AA・レスポンシブ・印刷対応）を適用し CHG-024 に記録。利用可能になった場合の適用候補として本欄を更新する |

## 3. 本プロジェクト固有の検証手段

| 手段 | 用途 | 実施方法 |
|---|---|---|
| scripts/check-links.py | 全 Markdown／HTML 相対リンクの検証 | `python3 scripts/check-links.py`（PASS を確認） |
| HTML構造検証 | タグ整合・閉じ忘れの確認 | セッション内で html.parser を使用 |
| Secret スキャン（gitleaks） | 秘密情報・資格情報のコミット防止 | CI（.github/workflows/ci.yml）の secretscan ジョブで PR/push 毎に実行 |
| レスポンシブ・印刷確認 | viewport・@media の有無 | 各HTMLのCSS確認 |

## 4. 記録・見直し

- 本表はツール環境の変化（GitHub連携開始、採用製品のPoC着手など）時に更新する。
- 適用判断は「外部書込み前に無害な読取りで接続先・権限・対象環境を特定する」原則に従う。
