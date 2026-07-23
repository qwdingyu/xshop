# scripts/ 脚本索引

> 最后更新：2026-07-19

## 快速导航

| 场景 | 命令 |
|------|------|
| **首次完整部署** | `CLOUDFLARE_API_TOKEN=xxx TURSO_URL=libsql://xxx.turso.io TURSO_TOKEN=xxx bash scripts/08-setup-local.sh` |
| **本地安装依赖** | `npm run deps:install`（不下载 Playwright 浏览器） |
| **配置 GitHub Actions** | 设置部署凭据与 `TURSO_API_TOKEN/TURSO_DB_NAME/BACKUP_ENCRYPTION_PASSPHRASE` 后执行 `bash scripts/10-setup-github.sh` |
| **仅部署（不 seed）** | `CLOUDFLARE_API_TOKEN=xxx TURSO_URL=libsql://xxx.turso.io TURSO_TOKEN=xxx ADMIN_TOKEN=xxx ESHOP_SEED_REMOTE=false npm run deploy:full` |
| **本地交付验证** | `CI=true npm run verify:delivery` |
| **复用本机 Chromium** | `npm run browser:chromium-path` |
| **远程上线门禁** | `BASE_URL=https://your-worker.workers.dev ADMIN_TOKEN=xxx TURSO_URL=libsql://xxx TURSO_TOKEN=xxx npm run verify:launch` |
| **本地开发测试** | `npm run dev` → `npm run smoke:readonly` |
| **数据库备份** | 设置 `TURSO_URL/TURSO_TOKEN/TURSO_API_TOKEN/TURSO_DB_NAME/BACKUP_ENCRYPTION_PASSPHRASE` 后执行 `bash scripts/12-ops-maintenance.sh backup-remote` |
| **清空业务数据** | `TURSO_URL=libsql://xxx TURSO_TOKEN=xxx bash scripts/22-cleanup-business-data.sh cleanup` |
| **轮换管理 Token** | `bash scripts/12-ops-maintenance.sh rotate-admin-token` |
| **绑定自定义域名** | `CLOUDFLARE_API_TOKEN=xxx ESHOP_BIND_DOMAIN=true npm run deploy:full` |

### 商品图片 R2（轻量方案）

商品封面和渠道 Logo 使用 `wrangler.jsonc` 中的 `PRODUCT_MEDIA` Binding。当前只有一个 Bucket，不需要 Cloudflare Images、S3 Access Key、预签名 URL 或浏览器直传。

首次使用前，在 Cloudflare Dashboard 启用 R2 一次，然后执行：

```bash
npx wrangler r2 bucket create cf-shop-public-media
npx wrangler r2 bucket info cf-shop-public-media --json
```

如果看到 `10042: Please enable R2 through the Cloudflare Dashboard`，说明是账户级 R2 尚未启用，不能通过 Worker 部署或 Wrangler 参数绕过。`npx wrangler dev` 默认使用本地 R2 模拟，不会写入远程 Bucket。
| **配置 Resend 邮件** | `bash scripts/11-setup-resend.sh` |

---

## 脚本执行顺序（严格按此顺序）

```
┌─────────────────────────────────────────────────────────────────┐
│                 eshop 部署流程（8步）                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  第1步: 01-check.mjs            结构检查（文件、配置、迁移）      │
│    ↓                                                            │
│  第2步: 02-deploy-full.mjs      完整部署（Turso → deploy）       │
│    ↓                                                            │
│  第3步: 03-bind-domain.mjs      绑定自定义域名                    │
│    ↓                                                            │
│  第4步: 04-smoke-readonly.mjs   只读冒烟测试                      │
│    ↓                                                            │
│  第5步: 05-smoke-admin.mjs      管理端冒烟测试                    │
│    ↓                                                            │
│  第6步: 06-smoke-write.mjs      写入冒烟测试                      │
│    ↓                                                            │
│  第7步: 07-verify-domain.mjs    域名 HTTPS 握手验证               │
│    ↓                                                            │
│  第8步: 08-setup-local.sh       本地一键部署（编排 01-07）        │
│    ↓                                                            │
│  第9步: 16-verify-launch.mjs    公开上线门禁（远程闭环验收）     │
│                                                                 │
│  配置类（首次部署后按需执行）:                                     │
│  09-configure-github.sh         GitHub Actions 配置（主力）       │
│  10-setup-github.sh             GitHub 配置（含支付/邮件 Secrets）│
│  11-setup-resend.sh             Resend API Key 配置               │
│                                                                 │
│  运维类（日常维护）:                                              │
│  12-ops-maintenance.sh          运维工具集（加密备份/轮换/清理）   │
│  13-apply-turso-migrations.sh   Turso 迁移                        │
│  22-cleanup-business-data.sh    清空业务数据（保留系统配置）        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 脚本清单

| 序号 | 脚本名 | 类型 | 用途 |
|------|--------|------|------|
| 01 | [`01-check.mjs`](./01-check.mjs) | mjs | 静态结构检查（文件存在、wrangler 配置、migration 表） |
| 02 | [`02-deploy-full.mjs`](./02-deploy-full.mjs) | mjs | 完整远程部署（Turso 迁移 → deploy → smoke，D1 仅显式兼容） |
| 03 | [`03-bind-domain.mjs`](./03-bind-domain.mjs) | mjs | Workers Custom Domain 绑定（Cloudflare API） |
| 04 | [`04-smoke-readonly.mjs`](./04-smoke-readonly.mjs) | mjs | 只读 smoke（health、商品列表、优惠码、/admin 不泄露） |
| 26 | [`26-smoke-frontend-assets.mjs`](./26-smoke-frontend-assets.mjs) | mjs | 部署后逐文件校验 SPA 入口与全部 hash JS/CSS 资源，防止 lazy chunk 404 |
| 05 | [`05-smoke-admin.mjs`](./05-smoke-admin.mjs) | mjs | 管理端 smoke（创建商品、导入卡密、manual 订单、确认发卡） |
| 06 | [`06-smoke-write.mjs`](./06-smoke-write.mjs) | mjs | 写入 smoke（创建订单、幂等键、direct 发卡闭环） |
| 07 | [`07-verify-domain.mjs`](./07-verify-domain.mjs) | mjs | 域名 HTTPS 握手 + /api/health 验证 |
| 08 | [`08-setup-local.sh`](./08-setup-local.sh) | bash | 本地一键部署（install → frontend:build → check → Turso → deploy → smoke → GitHub） |
| 09 | [`09-configure-github.sh`](./09-configure-github.sh) | bash | GitHub Actions 配置（精简版，已验证主力） |
| 10 | [`10-setup-github.sh`](./10-setup-github.sh) | bash | GitHub Actions 配置（含可选支付/邮件/Turnstile Secrets） |
| 11 | [`11-setup-resend.sh`](./11-setup-resend.sh) | bash | Resend API Key 配置到 Workers Secret |
| 12 | [`12-ops-maintenance.sh`](./12-ops-maintenance.sh) | bash | Turso 加密快照备份、rotate-token、cleanup |
| - | [`sync-turso-backup.mjs`](./sync-turso-backup.mjs) | mjs | 按 Turso 官方要求把 CLI 导出快照同步到远端最新可见帧（由 12 号脚本调用） |
| - | [`resolve-local-chromium.mjs`](./resolve-local-chromium.mjs) | mjs | 按显式路径、Playwright 缓存和系统安装顺序复用 Chromium，不下载浏览器 |
| 13 | [`13-apply-turso-migrations.sh`](./13-apply-turso-migrations.sh) | bash wrapper | 调用 `scripts/migrate.mjs`，只执行迁移 UP 段并记录 `schema_migrations` |
| - | [`install-dependencies.mjs`](./install-dependencies.mjs) | mjs | 以 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 执行锁定或普通 npm 依赖安装 |
| 22 | [`22-cleanup-business-data.sh`](./22-cleanup-business-data.sh) | bash | 安全清空业务/瞬态数据（18 张表），保留配置、审计与 API Key（5 张表） |
| 16 | [`16-verify-launch.mjs`](./16-verify-launch.mjs) | mjs | 公开上线门禁（远程 health、smoke、Turnstile、支付、邮件、备份） |
| 18 | [`18-smoke-catalog-admin.mjs`](./18-smoke-catalog-admin.mjs) | mjs | 目录/自动编号 smoke（分类配置、商品自动 ID、优惠码自动 code） |
| 19 | [`19-smoke-ops-crud.mjs`](./19-smoke-ops-crud.mjs) | mjs | 后台运营 CRUD smoke（卡密、批次、优惠码、取消订单、导出） |

### 辅助文件

| 文件 | 用途 |
|------|------|
| [`http-client.mjs`](./http-client.mjs) | Smoke 测试共享 HTTP 客户端（内部依赖） |

### Legacy 入口

历史上的非编号 smoke 入口（`smoke-readonly.mjs`、`smoke-admin.mjs`、`smoke.sh`）已经删除。
新流程必须使用编号脚本和 `package.json` 中的命令，避免同一验收目标存在多套口径。

---

## 调用关系

```
08-setup-local.sh        ← 入口：本地一键部署
  ├── npm install
  ├── frontend:build
  ├── 01-check.mjs
  ├── 02-deploy-full.mjs ← 入口：完整部署
  │     ├── Turso/libSQL migrations
  │     ├── wrangler deploy
  │     ├── 03-bind-domain.mjs  (ESHOP_BIND_DOMAIN=true)
  │     ├── 26-smoke-frontend-assets.mjs
  │     ├── 04-smoke-readonly.mjs
  │     ├── 05-smoke-admin.mjs
  │     └── 06-smoke-write.mjs
  └── 10-setup-github.sh  (gh CLI 可用时)

16-verify-launch.mjs     ← 入口：公开上线前最终门禁
  ├── /api/health
  ├── Turnstile 缺 token 强制拒绝检查
  ├── 26-smoke-frontend-assets.mjs
  ├── 04-smoke-readonly.mjs
  ├── 05-smoke-admin.mjs
  ├── 06-smoke-write.mjs
  ├── 18-smoke-catalog-admin.mjs
  ├── 19-smoke-ops-crud.mjs
  ├── /api/admin/payment/providers
  ├── /api/admin/test-email
  └── 12-ops-maintenance.sh backup-remote 或备份确认

12-ops-maintenance.sh    ← 入口：运维操作
  ├── backup-remote
  ├── rotate-admin-token
  └── cleanup-idempotency-keys

22-cleanup-business-data.sh ← 入口：清空业务数据
  ├── preview（只读检查）
  └── cleanup（事务清空 + 验证）

04/05/06-smoke-*.mjs     ← 均依赖 http-client.mjs
07-verify-domain.mjs     ← 独立
11-setup-resend.sh       ← 独立
13-apply-turso-migrations.sh ← 迁移包装器，内部委托 scripts/migrate.mjs
```

---

## 环境变量速查

| 变量 | 用途 | 必需于 |
|------|------|--------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API 鉴权 | 部署、域名、Worker Secret 轮换 |
| `ADMIN_TOKEN` | 管理后台鉴权 | smoke:admin, smoke:write, smoke:catalog-admin, smoke:ops |
| `RESEND_API_KEY` | Resend 邮件 API（也可后台配置） | 邮件通知、邮箱访问码、余额/精确查单能力 |
| `EMAIL_FROM` | 发件人地址（也可后台配置） | 邮件发送 |
| `ESHOP_WORKER_NAME` | Worker 名称（默认 cf-shop） | deploy, rotate-admin-token |
| `APP_ORIGIN` | 唯一公网 HTTPS 根地址（必填，不猜测） | deploy / domain bind / smoke |
| `ESHOP_CUSTOM_DOMAIN` | 自定义域名（可选，默认从 APP_ORIGIN 提取） | domain bind |
| `ESHOP_BIND_DOMAIN` | 是否绑定域名（默认 false） | deploy-full |
| `ESHOP_SEED_REMOTE` | 是否执行 seed（默认 true） | deploy-full |
| `TURSO_URL` / `TURSO_TOKEN` | libSQL 数据库连接凭据 | Worker、迁移、数据清理、导出后最新帧同步 |
| `TURSO_API_TOKEN` | Turso 平台 API Token | `db export` 快照备份 |
| `TURSO_DB_NAME` | Turso 数据库名称 | `db export` 快照备份 |
| `BACKUP_ENCRYPTION_PASSPHRASE` | 至少 20 字符的独立备份口令 | 备份归档加密 |
| `BASE_URL` | 目标地址（默认 localhost:8790） | smoke, verify |
| `TURNSTILE_SECRET_KEY` | Turnstile Secret | verify:launch |
| `CREDENTIALS_ENCRYPTION_KEY` | 支付配置加密密钥（64 hex） | payment config, verify:launch |
| `LAUNCH_TEST_EMAIL_TO` | 接收测试邮件的真实邮箱 | verify:launch |
| `LAUNCH_ALLOW_OFFLINE_ONLY` | 允许仅线下收款试运营 | verify:launch |
| `LAUNCH_ACK_ENV_PAYMENT_READY` | 确认生产 Worker 已通过 secret 配置支付渠道 | verify:launch |
| `LAUNCH_RUN_BACKUP` | 执行一次 Turso 备份 | verify:launch |
| `LAUNCH_ACK_BACKUP_READY` | 确认外部已验证备份 | verify:launch |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | 显式指定已安装 Chromium；未设置时自动扫描现有缓存 | 浏览器验收 |

## 本机 Chromium 复用

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$(npm run --silent browser:chromium-path)"
```

Playwright 启动时传入 `executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。解析器只接受已存在且可执行的浏览器；`npm run deps:install` / `npm run deps:ci` 会在依赖安装时跳过 Playwright 浏览器下载，解析失败时应修正本机路径，不应在日常测试中执行 `playwright install`。

## 上线门禁说明

`verify:delivery` 只证明本地代码、类型、单测、前端构建和结构检查可交付；`verify:launch` 才证明真实远程环境可公开小流量上线。

推荐命令：

```bash
BASE_URL="https://your-worker.workers.dev" \
ADMIN_TOKEN="xxx" \
TURSO_URL="libsql://xxx.turso.io" \
TURSO_TOKEN="xxx" \
TURSO_API_TOKEN="xxx" \
TURSO_DB_NAME="your-database" \
BACKUP_ENCRYPTION_PASSPHRASE="至少20字符的独立备份口令" \
TURNSTILE_SECRET_KEY="xxx" \
CREDENTIALS_ENCRYPTION_KEY="64位hex" \
RESEND_API_KEY="re_xxx" \
EMAIL_FROM="Your Shop <noreply@example.com>" \
LAUNCH_TEST_EMAIL_TO="owner@example.com" \
LAUNCH_RUN_BACKUP=true \
npm run verify:launch
```

如果当前阶段只做线下收款试运营，可显式追加 `LAUNCH_ALLOW_OFFLINE_ONLY=true`。如果线上支付不是通过管理端配置，而是通过 Worker secrets 配置，可追加 `LAUNCH_ACK_ENV_PAYMENT_READY=true` 表示已人工确认生产 secrets。 如果备份已由外部平台或手工流程验证，可用 `LAUNCH_ACK_BACKUP_READY=true` 代替 `LAUNCH_RUN_BACKUP=true`。

生产环境启用 `TURNSTILE_SECRET_KEY` 后，远程写入 smoke 需要提供真实 `SMOKE_TURNSTILE_TOKEN`，或仅在受控 smoke 窗口把 Worker secret `ALLOW_TURNSTILE_BYPASS_FOR_SMOKE=true` 与 `ADMIN_TOKEN` 配合使用；结束后应关闭 bypass。

## 加密备份恢复演练

从 GitHub Actions 的 `Daily Database Backup` 下载同一批次的 `.enc` 和 `.sha256` 后，在隔离目录执行：

```bash
sha256sum -c turso_<database>_<timestamp>.tar.gz.enc.sha256
export BACKUP_ENCRYPTION_PASSPHRASE='<与备份时相同的独立口令>'
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
  -in turso_<database>_<timestamp>.tar.gz.enc \
  -out restore.tar.gz \
  -pass env:BACKUP_ENCRYPTION_PASSPHRASE
tar -xzf restore.tar.gz
sqlite3 turso_<database>_<timestamp>.db 'PRAGMA integrity_check;'
turso db create cf-shop-restore-drill \
  --from-file turso_<database>_<timestamp>.db \
  --wait
```

`integrity_check` 必须只输出 `ok`。随后对照归档内 manifest 的 `snapshot_sha256` 和 `migration_version`，把测试 Worker 临时指向恢复库执行只读、管理和库存 smoke；验证完成后删除测试库。不要直接覆盖生产库，也不要把解密后的 `.db/.tar.gz` 放入仓库目录。

---

## 踩坑记录

详见 [DEPLOY-GUIDE.md](./DEPLOY-GUIDE.md)
