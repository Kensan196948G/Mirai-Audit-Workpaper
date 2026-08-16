# アプリ運用・障害対応Runbook（app/）

> 対象: 要件定義書 MAW-RD-001 の実装アプリ（app/）の日次〜四半期運用手順。
> 作成: 2026-08-16（CTO）／状態: 実装済み（app/ と連動）。正式な本番運用（実データ）は社内決定と受入試験の完了が前提。

## 1. 構成と環境

| 環境 | URL | Worker名 | D1（DB） | 用途 | bootstrap |
|---|---|---|---|---|---|
| preview | https://mirai-audit-workpaper-preview.kensan1969.workers.dev | mirai-audit-workpaper-preview | mirai-audit-workpaper-mvp-db | 内部検証（ダミーデータのみ） | 可（BOOTSTRAP_PASSWORD は Cloudflare Secret・Git非管理） |
| MVP | https://maw-mvp.mirai-dx-platform.com | mirai-audit-workpaper-mvp | mirai-audit-workpaper-mvp-db | 顧客向けMVP・受入試験（ダミーデータのみ） | 可（BOOTSTRAP_PASSWORD は Cloudflare Secret・Git非管理） |
| production | https://maw.mirai-dx-platform.com | mirai-audit-workpaper | mirai-audit-workpaper-db | 本番（実データ投入は社内決定後） | 不可（403） |

- 技術: Cloudflare Workers（Hono・TypeScript）+ D1（SQLite）+ ネイティブHTML/JS SPA（worker内埋め込み）
- ソース: app/（src/・migrations/・web/・tests/）。デプロイ設定: app/wrangler.jsonc（preview）、app/wrangler.mvp.jsonc（MVP）、app/wrangler.production.jsonc（production）
- カスタムドメイン: mirai-dx-platform.com ゾーン（本アカウント管理）上に maw / maw-mvp を Worker カスタムドメインとして設定済み
- 監査ログ: audit_events テーブル（追記専用）。全API操作が記録される
- テスト用パスワード: preview/MVP の BOOTSTRAP_PASSWORD とダミーユーザーパスワードは Cloudflare Secret で管理（値は Git・画面・ログに出力しない）。ローカル運用時は `MAW_SEED_PASSWORD` 環境変数で指定する

## 2. デプロイ手順

### 2.1 前提
- main ブランチの確定 commit が CI（.github/workflows/ci.yml）の型チェック・lint・テスト・ビルド・リンク検証・シークレットスキャン（gitleaks）を通過していること
- secrets: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID が GitHub に設定されていること
- デプロイワークフロー（.github/workflows/deploy.yml）は main への push で preview・MVP を自動デプロイし、production は workflow_dispatch の target=production 明示指定時のみ実行する（push では実行されない）

### 2.2 preview / MVP デプロイ（main への push で自動実行）
- 手動実行: GitHub Actions > Deploy > Run workflow（target: preview-mvp / preview / mvp を選択）または下記ローカル手順

```bash
cd app
npm ci
npx wrangler d1 migrations apply mirai-audit-workpaper-mvp-db -c wrangler.jsonc   # 冪等（preview）
npx wrangler d1 migrations apply mirai-audit-workpaper-mvp-db -c wrangler.mvp.jsonc  # 冪等（MVP・同一DB）
npm run deploy:preview                                                            # build + wrangler deploy -c wrangler.jsonc
npm run deploy:mvp                                                                 # build + wrangler deploy -c wrangler.mvp.jsonc
```

- スモーク: `curl https://mirai-audit-workpaper-preview.kensan1969.workers.dev/api/health` および `curl https://maw-mvp.mirai-dx-platform.com/api/health` で `"db":"ok"` を含む `{"status":"ok"}` を確認

### 2.3 production デプロイ（手動実行のみ・target=production）
- 受入条件（受入試験・権限棚卸し・復元試験・教育）クリア後に GitHub Actions > Deploy > Run workflow（target: production）で実行
- ローカル手順:

```bash
cd app
npm ci
npx wrangler d1 migrations apply mirai-audit-workpaper-db -c wrangler.production.jsonc  # 冪等
npm run deploy:production
```

- スモーク:
  - `curl https://maw.mirai-dx-platform.com/api/health` で `"db":"ok"` を含む `{"status":"ok"}` を確認
  - `curl -s -o /dev/null -w '%{http_code}' -X POST https://maw.mirai-dx-platform.com/api/admin/bootstrap` → `403` を確認（本番bootstrap無効）
- 安全化: production ジョブは migration 前に `wrangler d1 export` で SQL バックアップを作成し、GitHub Actions アーティファクト（30日保持）に保存する

### 2.4 ロールバック
- Cloudflare Dashboard > Workers > mirai-audit-workpaper > Deployments から直前のデプロイメントを Rollback（Workers の履歴ロールバック）
- または旧 commit で production を再デプロイ
- 注意: D1 migration は冪等だが、破壊的 migration を追加する場合は事前にバックアップ確認とレビューを行う

## 3. DB（D1）

- migration: app/migrations/0001_initial.sql（冪等: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS）
- シード（preview/MVP のみ）: `MAW_SEED_PASSWORD=... node scripts/seed.mjs --remote` で scripts/seed-users.sql を生成し `npx wrangler d1 execute <db> --file scripts/seed-users.sql` で適用（ダミーパスワードハッシュのみ。本番へは適用しない。パスワード値はログ出力しない）
- バックアップ・復元: Cloudflare Dashboard > D1 > 対象DB > Backups で時点復元（RPO/RTO は社内決定後に SLI/SLO へ反映）
- 監査ログ: audit_events は追記専用（UPDATE/DELETE のAPIなし）。必要に応じ export で保全

### 3.1 本番の初期管理者プロビジョニング（実データ運用開始時）
- 本番は bootstrap が恒久的に無効のため、初回管理者は開発者・システム管理者がローカルで PBKDF2 ハッシュを生成し、D1 へ INSERT する運用手順とする（`app/scripts/seed.mjs` 相当の生成を `MAW_SEED_PASSWORD` 指定で実施し、SQL はローカル一時ファイルのみ・Git 非管理）。
- 初回管理者の作成後は、アプリの「ユーザー管理」画面から追加ユーザーの作成・ロール設定・無効化を行う。
- 初期パスワードは安全な経路（社内パスワード管理ツール等）で本人へ引き渡し、初回ログイン後の変更を必須とする。

## 4. 監視・アラート

- オブザーバビリティ: wrangler 設定で有効（preview 1.0 / production 0.1 サンプリング）。Cloudflare Dashboard > Workers > 対象Worker > Logs / Metrics
- ヘルスチェック: GET /api/health（status・environment・db死活・time。DB異常時は 503 + db:error）
- アラート試験・SLI/SLO: 社内決定後に Uptime（Cloudflare）や外部監視で設定。初期安定化期間（1〜2週間）はエラー率・ログを日次確認

## 5. 障害対応

| 障害 | 検知 | 対応 |
|---|---|---|
| Worker 5xx | Logs・Uptime | ログ確認 → 原因特定 → 修正PR → preview確認 → production再デプロイ。急場は直前デプロイへ Rollback |
| D1 エラー・データ不整合 | エラーレート・監査ログ欠落 | バックアップからの時点復元（復元試験後に実施）。原因をインシデント記録へ |
| 認証不能・ログイン障害 | ログインエラー率 | セッション掃除（purgeExpiredSessions）・レート制限状態を確認。DB sessions の整合確認 |
| セキュリティインシデント（漏えい・不正アクセス疑い） | 監査ログ・アラート | 直ちに production Worker を停止/ロールバックし、監査ログ保全、関係者へ報告。復旧後に再発防止策を実装 |

## 6. 運用台帳（周期）

| 周期 | 作業 | 担当 |
|---|---|---|
| 日次（初期安定化） | エラー率・監査ログ・メトリクス確認 | 運用担当 |
| 週次 | バックアップ確認・未処理インシデント棚卸し | 運用担当 |
| 月次 | 権限棚卸し（ユーザー・ロール）、依存関係/脆弱性スキャン、証明書・ドメイン確認 | システム管理者 |
| 四半期 | 復元試験（RPO/RTO実測）、容量・レート・予算レビュー、Runbook更新 | 運用・CTO |
| 年次 | ライセンス・EOL・保存年限レビュー、教育再実施 | 総務部・システム管理者 |

## 7. 運用上の注意

- 実データ（個人情報・会社データ）を preview やテストへ投入しない。シードはダミーのみ
- 監査判断・重要度・完了判定は人が行う。システムは自動決定しない
- .env・資格情報・トークンを Git・ログ・文書へ出力しない。ローテーションは Cloudflare Dashboard / 環境変数で実施
- 本Runbookの変更は docs/変更履歴.md に記録する
