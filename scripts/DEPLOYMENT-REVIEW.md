# cf-shop 部署链路审查与发布方案

> 最后更新：2026-06-27  
> 适用版本：基于当前 main 分支快照

---

## 一、脚本清单与用途

| 类别 | 脚本 | 用途 |
|------|------|------|
| **本地结构检查** | `01-check.mjs` | 验证关键文件、wrangler 配置、migration 表、前后端代码约定 |
| **完整部署** | `02-deploy-full.mjs` | Turso 迁移 → wrangler deploy（含 secrets） → 可选域名绑定 → 自动 smoke |
| **域名绑定** | `03-bind-domain.mjs` | Cloudflare API 绑定 Workers Custom Domain，支持增量/替换 |
| **只读冒烟** | `04-smoke-readonly.mjs` | health、商品、优惠码、/admin 无 token 拒绝、/admin 不 307 |
| **管理端冒烟** | `05-smoke-admin.mjs` | 创建商品、导入卡密、生成优惠券、manual 订单、mark-paid、发卡 |
| **写入冒烟** | `06-smoke-write.mjs` | 创建 direct 订单、幂等键、lookup、delivery 闭环 |
| **域名验证** | `07-verify-domain.mjs` | HTTPS 握手 + /api/health 轮询验证 |
| **本地一键部署** | `08-setup-local.sh` | 编排 01→02→03→04→05→06→07，适合裸仓库首次部署 |
| **GitHub 配置** | `09-configure-github.sh` | 配置 CLOUDFLARE_API_TOKEN、ADMIN_TOKEN、TURSO_* 等 Secrets/Variables |
| **Resend 配置** | `11-setup-resend.sh` | 交互式设置 RESEND_API_KEY Worker Secret |
| **运维工具集** | `12-ops-maintenance.sh` | 远程备份、管理数据导出、轮换 ADMIN_TOKEN、清理过期幂等键 |
| **Turso 迁移** | `13-apply-turso-migrations.sh` | 委托 `scripts/migrate.mjs`，按 UP 段执行并记录迁移状态 |
| **Turnstile 配置** | `14-setup-turnstile.mjs` | 自动创建 Turnstile Widget、写入 Site Key、设置 Secret |
| **前端资产同步** | `15-sync-frontend-assets.mjs` | 将 frontend/dist 同步到 public/_app |
| **前端资产冒烟** | `26-smoke-frontend-assets.mjs` | 对照本次构建清单校验线上 SPA 入口和全部 hash/lazy JS、CSS |
| **上线门禁** | `16-verify-launch.mjs` | 远程 health + 三类 smoke + Turnstile + 支付 + 邮件 + 备份；默认 `LAUNCH_MODE=public`，任何警告都会失败 |
| **核心覆盖门禁** | `17-verify-core-coverage.mjs` | 静态检查关键业务测试和 smoke 入口未被误删 |

### 辅助文件

| 文件 | 用途 |
|------|------|
| `http-client.mjs` | Smoke 测试共享 HTTP 客户端（内部依赖） |

---

## 二、核心设计意图

1. **本地交付 vs 远程上线分离**  
   `verify:delivery` 只证明本地代码可构建、类型通过、单测覆盖、结构检查通过；`verify:launch` 才证明真实远程环境可公开上线。

2. **数据库双引擎兼容，默认 Turso**  
   `DATABASE_PROVIDER` 支持 `turso`（默认）和 `d1`（显式兼容）。`02-deploy-full.mjs`、`12-ops-maintenance.sh`、`migrate.mjs` 均通过环境变量切换。

3. **Secrets 不上 Git，通过 wrangler --secrets-file 原子部署**  
   TURSO_URL、TURSO_TOKEN、ADMIN_TOKEN 等敏感信息通过临时 `.deploy-secrets.env` 传入 wrangler，部署后立即清空删除。

4. **Smoke 闭环覆盖三类场景**  
   - 只读：health、商品、优惠码、/admin 不泄露、system-config
   - 管理：商品 CRUD、卡密导入、优惠券生成、manual 订单、mark-paid、系统参数修改
   - 写入：direct 订单创建、幂等键、lookup、delivery 闭环

5. **上线门禁强制检查**  
   包含 Turnstile 缺 token 拒绝、支付渠道启用状态、邮件发送能力、数据库备份准备。

---

## 三、全量发布方案

### 方案 A：全新环境首次完整部署（推荐）

```bash
# 前置：确保已安装 node、npm、turso CLI、gh CLI
CLOUDFLARE_API_TOKEN="cfat_xxx" \
TURSO_URL="libsql://xxx.turso.io" \
TURSO_TOKEN="eyJ..." \
bash scripts/08-setup-local.sh

# 配置 GitHub Actions（自动推送 Secrets）
bash scripts/09-configure-github.sh

# 配置 Turnstile（可选，公开站点建议）
node scripts/14-setup-turnstile.mjs

# 配置 Resend（可选，邮件通知需要）
bash scripts/11-setup-resend.sh
```

### 方案 B：已有环境增量更新

```bash
# 1. 本地构建验证
CI=true npm run verify:delivery

# 2. 部署（不重复 seed，可绑定域名）
CLOUDFLARE_API_TOKEN="cfat_xxx" \
ADMIN_TOKEN="xxx" \
TURSO_URL="libsql://xxx.turso.io" \
TURSO_TOKEN="eyJ..." \
ESHOP_SEED_REMOTE=false \
ESHOP_BIND_DOMAIN=true \
npm run deploy:full

# 3. 域名验证
BASE_URL="https://shop.example.com" npm run verify:domain
```

### 方案 C：仅更新 Worker 代码（无数据库变更）

```bash
npm run frontend:build
CLOUDFLARE_API_TOKEN="cfat_xxx" \
ADMIN_TOKEN="xxx" \
TURSO_URL="libsql://xxx.turso.io" \
TURSO_TOKEN="eyJ..." \
npm run deploy
```

---

## 四、完整发布链路验证清单

| 阶段 | 脚本/命令 | 验证点 | 失败处理 |
|------|-----------|--------|----------|
| **本地检查** | `npm run check` | 关键文件存在、wrangler 配置、migration 表、前后端代码约定 | 修复代码结构问题 |
| **类型与测试** | `npm run type-check && npm run test` | TypeScript 类型、单元测试通过 | 修复类型错误或测试失败 |
| **前端构建** | `npm run frontend:build` | Vue 构建成功、产物同步到 `public/_app` | 修复前端构建错误 |
| **核心覆盖** | `npm run verify:core` | 关键业务测试和 smoke 入口未被误删 | 补充缺失的测试或 smoke |
| **迁移** | `npm run db:migrate` | Turso 迁移成功，schema_migrations 记录 | 检查迁移 SQL 语法 |
| **部署** | `npm run deploy:full` | Worker 部署成功、secrets 上传、system_config seed | 检查 CLOUDFLARE_API_TOKEN、TURSO_* |
| **只读 Smoke** | `npm run smoke:readonly` | health、商品、优惠码、/admin 无 token 拒绝、/admin 不 307 | 检查 Worker 路由和 Static Assets 配置 |
| **前端资产 Smoke** | `npm run smoke:frontend-assets` | 入口版本、全部构建资源可达性、HTML no-store、成功 hash 资源 immutable | 检查是否命中旧部署、资源上传是否完整、缓存头是否错误 |
| **管理 Smoke** | `npm run smoke:admin` | 商品 CRUD、卡密导入、manual 订单、mark-paid、系统参数 | 检查 ADMIN_TOKEN、数据库写入权限 |
| **写入 Smoke** | `npm run smoke:write` | direct 订单、幂等键、lookup、delivery | 检查 direct 库存、发卡逻辑 |
| **域名验证** | `npm run verify:domain` | HTTPS 握手、/api/health 返回 eshop/turso | 检查 DNS、Cloudflare 绑定、边缘传播 |
| **上线门禁** | `npm run verify:launch` | 远程 health、smoke、Turnstile、支付、邮件、备份 | 逐项检查 FAIL 项 |

---

## 五、CI/CD 自动执行链路

```
GitHub Push
    │
    ▼
.github/workflows/deploy.yml (推测存在，基于 .github/workflows/ 目录)
    │
    ├── npm run verify:delivery (本地检查)
    │       ├── type-check
    │       ├── test
    │       ├── frontend:build
    │       ├── 01-check.mjs
    │       └── verify:core
    │
    ├── npm run deploy:full (远程部署)
    │       ├── db:migrate:turso
    │       ├── wrangler deploy --secrets-file
    │       ├── 04/05/06-smoke-*.mjs
    │       └── 03-bind-domain.mjs (ESHOP_BIND_DOMAIN=true)
    │
    └── 定时任务
            ├── backup-daily.yml (每日 3:00 UTC 备份)
            └── cleanup-schedule.yml (每 2 小时清理过期资源)
```

---

## 六、潜在风险与建议

| 风险 | 说明 | 建议 |
|------|------|------|
| `02-deploy-full.mjs` 自动执行 smoke | 部署脚本包含真实创建订单/卡密的 smoke，可能在 CI 中消耗库存 | CI 中使用独立 smoke 脚本，或确保测试库存充足 |
| `ESHOP_SEED_REMOTE` 默认 true | 首次部署会 seed，后续可能重复 | 后续部署显式设置 `ESHOP_SEED_REMOTE=false` |
| Turso CLI vs libsql Client | 迁移包装器和 Worker 运行时统一委托 `migrate.mjs` 使用 `@libsql/client` | 不要把含有 DOWN 段的完整 SQL 文件直接输入 Turso CLI |
| `ALLOW_TURNSTILE_BYPASS_FOR_SMOKE` | smoke 可绕过 Turnstile，需确保仅测试环境开启 | 生产环境关闭，smoke 窗口开启后及时关闭 |
| 加密快照备份依赖平台凭据 | `verify:launch` 调用 `turso db export`，数据库连接 Token 无权替代平台 API Token | 配置 `TURSO_API_TOKEN`、`TURSO_DB_NAME`、独立备份口令，并执行真实恢复演练 |

---

## 七、发布参数清单

### 必填参数

| 参数 | 说明 | 获取方式 |
|------|------|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，用于部署、域名绑定、D1 兼容运维 | [Cloudflare Dashboard → Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) |
| `TURSO_URL` | Turso 数据库 URL | Turso Dashboard → Database → Connection URL |
| `TURSO_TOKEN` | Turso 认证 Token | Turso Dashboard → Database → Auth Token |

### 可选但常用参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `ADMIN_TOKEN` | 管理后台 Token，用于 smoke 和管理操作 | 未设置时自动生成随机值 |
| `ESHOP_WORKER_NAME` | Worker 名称 | `cf-shop` |
| `APP_ORIGIN` | 唯一公网 HTTPS 根地址 | `https://shop.example.com` |
| `ESHOP_BIND_DOMAIN` | 是否绑定自定义域名 | `false` |
| `ESHOP_SEED_REMOTE` | 是否执行远程 seed | `true`（首次）/ `false`（后续） |
| `DATABASE_PROVIDER` | 数据库引擎 | `turso` |
| `BASE_URL` | 目标地址，用于 smoke 和 verify | workers.dev 或自定义域名 |

### 上线门禁额外参数（仅 verify:launch 需要）

| 参数 | 说明 |
|------|------|
| `TURNSTILE_SECRET_KEY` | Turnstile Secret Key |
| `CREDENTIALS_ENCRYPTION_KEY` | 支付配置加密密钥（64 位 hex） |
| `RESEND_API_KEY` | Resend 邮件 API Key |
| `EMAIL_FROM` | 发件人地址 |
| `LAUNCH_TEST_EMAIL_TO` | 接收测试邮件的真实邮箱 |
| `LAUNCH_MODE` | `public` 默认严格公开上线；`trial` 仅用于受控试运营，允许显式豁免警告但不允许失败 |
| `LAUNCH_ALLOW_OFFLINE_ONLY` | 允许仅线下收款试运营 |
| `LAUNCH_ACK_ENV_PAYMENT_READY` | 确认生产 Worker 已通过 secret 配置支付渠道 |
| `LAUNCH_RUN_BACKUP` | 执行一次 Turso 备份 |
| `LAUNCH_ACK_BACKUP_READY` | 确认外部已验证备份 |

---

## 八、如何提供参数

### 方式 1：环境变量（推荐）

直接在命令前设置环境变量：

```bash
CLOUDFLARE_API_TOKEN="cfat_xxx" \
TURSO_URL="libsql://xxx.turso.io" \
TURSO_TOKEN="eyJ..." \
ADMIN_TOKEN="xxx" \
bash scripts/08-setup-local.sh
```

### 方式 2：.env 文件

创建 `.env.local` 文件（已加入 .gitignore）：

```env
CLOUDFLARE_API_TOKEN=cfat_xxx
TURSO_URL=libsql://xxx.turso.io
TURSO_TOKEN=eyJ...
ADMIN_TOKEN=xxx
```

然后直接执行：

```bash
bash scripts/08-setup-local.sh
```

### 方式 3：交互式输入

部分脚本支持交互式输入，例如：

```bash
bash scripts/09-configure-github.sh
# 会提示输入 CLOUDFLARE_API_TOKEN
```

### 方式 4：导出到当前 Shell

```bash
export CLOUDFLARE_API_TOKEN="cfat_xxx"
export TURSO_URL="libsql://xxx.turso.io"
export TURSO_TOKEN="eyJ..."
bash scripts/08-setup-local.sh
```

### 安全提示

- **不要将敏感参数提交到 Git**
- `.env.local` 已加入 `.gitignore`
- Worker Secrets 通过 `wrangler secret put` 设置，不会出现在代码中
- 部署脚本使用 `--secrets-file` 临时文件，部署后立即清空删除
