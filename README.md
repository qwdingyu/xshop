# xshop

### 开源自动发卡商城 · Cloudflare Workers Serverless · 零 VPS 数字商品 / 卡密 / 虚拟资料售卖

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Runtime](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Stack](https://img.shields.io/badge/Hono-TypeScript-E36002)](https://hono.dev/)
[![DB](https://img.shields.io/badge/Turso-libSQL-4FF8D2)](https://turso.tech/)
[![Frontend](https://img.shields.io/badge/Vue_3-SPA-42b883?logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![ORM](https://img.shields.io/badge/Drizzle-ORM-C5F74F)](https://orm.drizzle.team/)
[![Pay](https://img.shields.io/badge/EasyPay-Compatible-0ea5e9)](#支付与资金)

> **一句话定位**：在 **Cloudflare Workers** 边缘上跑完整的 **开源自动发卡系统 / 虚拟商品商城**——上架、收款、原子发卡、邮件交付、余额钱包、优惠码、多展示渠道、运营后台，**不需要自建 VPS、Docker 或宝塔**。

**仓库**：[github.com/qwdingyu/xshop](https://github.com/qwdingyu/xshop) · **协议**：MIT · **语言**：TypeScript（全栈）

### Agent 速览（给 AI / 快速扫读）

| 项 | 内容 |
|----|------|
| **是什么** | 开源 **数字商品店面 + 自动卡密/激活码发货**，跑在 Cloudflare Workers |
| **技术栈** | Workers · Hono · Turso/libSQL · Drizzle · Vue 3 · Zod · R2 · Turnstile |
| **主闭环** | 上架 → 统一下单（在线/余额/免费/线下）→ 支付/确认 → **原子发卡或履约** → 邮件/前台交付 → Admin 对账 |
| **支付** | **EasyPay 兼容**在线收款 + 余额钱包 + 线下确认（非 Stripe-only 叙事） |
| **边界** | 不做实体仓配 / ERP；**余额账本为 CNY 单一币种**；轻量商城，非超大中台 |
| **怎么跑** | `npm install` → `npm run db:migrate` → `npm run frontend:build` → `npm run dev` |
| **真相来源** | 行为以 `src/`、`frontend/`、`migrations/`、测试与 **本 README** 为准 |

**English summary (search & AI discovery):**

> **xshop** is an **open-source digital goods storefront** and **auto license-key / card-key delivery shop** for **Cloudflare Workers** + **Turso (libSQL)** + **Hono** + **Vue 3**.  
> Sell **activation codes, CDK, VIP memberships, redeem codes, virtual downloads, netdisk links** with **EasyPay-compatible online payment**, **balance wallet** (recharge codes + online top-up + balance checkout + admin ledger), **coupons**, **multi-storefront channels**, **R2 product images**, **email delivery**, **Turnstile**, **idempotent checkout**, and a full **admin SPA**.  
> **MIT licensed**. No mandatory SaaS platform cut. **Swiss-army-knife** scope: small, auditable, production-minded—not a heavy ERP.

---

## 目录

- [为什么选 xshop](#为什么选-xshop)
- [适合谁 / 不适合谁](#适合谁--不适合谁)
- [解决什么痛点](#解决什么痛点)
- [场景对照](#场景对照)
- [核心能力](#核心能力)
- [差异化亮点](#差异化亮点)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [环境变量](#环境变量)
- [商品图片 R2](#商品图片-r2)
- [公开 API 边界](#公开-api-边界)
- [目录结构](#目录结构)
- [设计原则](#设计原则)
- [FAQ](#faq)
- [质量门禁](#质量门禁)
- [贡献与许可](#贡献与许可)

---

## 为什么选 xshop

真实优势对照（不空吹）：

| 你真正关心的 | xshop 怎么做 | 行业常见替代 |
|-------------|----------------|-------------|
| **不想养服务器** | 整站 **Cloudflare Workers** 边缘运行，无 Docker / K8s / 宝塔运维面 | VPS + PHP 发卡站、每月续费补丁 |
| **起步成本可控** | Workers + Turso 可用免费额度冷启动（**以官方配额为准**） | 云主机 + 面板 + 数据库一堆账单 |
| **卖的是数字货** | 卡密 **原子锁定发放**、库存由卡密统计、邮件 / 前台交付、限购可配 | 手工微信发卡、表格对账 |
| **国内收款习惯** | 内置 **易支付兼容（EasyPay）** Provider；另支持余额 / 线下确认 / 免费领取 | 只讲 Stripe、不接常见易支付通道 |
| **要钱包闭环** | 充值码兑换 · 在线余额充值 · 余额支付 · 流水 · **后台用户余额管理 / 手工调账** | 只有支付，没有可运营账本 |
| **多种交付形态** | `card` / `virtual` / `link` / `code` / `invite` 履约模式 | 单一卡密模板硬套所有业务 |
| **多渠道展示** | **storefront 展示渠道**：同一商品池，多入口映射与排序 | 多站重复上架、库存分裂 |
| **后台能干活** | Vue 3 Admin：商品 / 渠道 / 卡密 / 订单 / 优惠码 / 充值 / 用户余额 / 支付 / 日志 | 半成品后台或纯 API |
| **代码可审计** | TypeScript 全栈、事务化关键路径、幂等下单、限流、审计日志、门禁脚本 | 闭源 SaaS 或难以 fork 的单体 |
| **开源可商用** | **MIT**，可私有部署、可二开；**无平台强制抽成**（通道与云费用另计） | 月租 + 抽成吃掉薄利 |

**一句话记住我们**：**Serverless 边缘上的开源自动发卡商城**——给个人站长、副业卖家、社群运营、卡密 / 激活码 / 会员码 / 虚拟资料卖家用的「小而美」闭环，而不是重型电商中台。

---

## 适合谁 / 不适合谁

### 适合你，如果

- 想自建 **自动发卡系统 / 卡密商店 / 虚拟商品商城 / 数字商品店**
- 接受 **先以 CNY 为主结算**；余额账本为 **单一 CNY**（商品侧可有币种字段与展示脚手架）
- 喜欢 **Cloudflare Workers + Turso** 这类 Serverless，而不是再买一台 VPS
- 需要 **易支付兼容收款**、余额预付、优惠码、邮件交付、运营后台
- 愿意以 **源码 + 测试 + 本 README** 为契约做二开与上线

### 不适合你，如果

- 需要 **实体物流仓配、复杂 ERP、多仓库 SKU**
- 需要 **多币种实时换汇钱包** 或跨境多国支付编排
- 需要「开箱即用 SaaS 全托管客服 + 营销自动化中台」——那是另一类产品

---

## 解决什么痛点

| 痛点 | xshop 的回答 |
|------|----------------|
| 卖卡密 / CDK / 激活码还要搭 LAMP、宝塔、PHP 发卡站？ | **Workers 部署**，边缘 API + Vue SPA |
| 大平台卖数字货，**月租 + 抽成**吃掉薄利？ | **自托管 MIT 开源**，无强制平台抽成 |
| 想 Serverless，又被重框架 / 重数据库劝退？ | **Hono + Turso/libSQL + Drizzle**，SQLite 语义、边缘友好 |
| 收款后还要手工对账、手工发卡、客服扯皮？ | **支付成功 → 原子发卡 / 履约 → 邮件通知 → 后台可查** |
| 社群预付、充值码、余额买货管不过来？ | **充值码 + 在线充值 + 余额支付 + 流水 + 管理员调账** |
| 活动免费领码、网盘资料、邀请码混在一起难配？ | **多种履约模式 + 限购 + 交付可见性** |

---

## 场景对照

| 场景 | 传统做法 | 用 xshop |
|------|----------|----------|
| 游戏 / 软件 **卡密自动发货** | VPS + PHP 发卡站 + 人工补发 | Workers 部署 → 支付成功 **原子发卡** |
| **充值码 / 预付余额** 社群卖货 | 表格记账、私聊转账 | 充值码、在线充值、余额支付、流水可查 |
| **电子资料 / 网盘链接** 虚拟交付 | 链接过期、售后扯皮 | `virtual` / `link` 等履约 + 邮件 / 前台可见性可配 |
| **活动统一兑换码 / 免费领取** | 群公告发同一串、无法统计 | 0 元商品 + 限购 + 订单留痕 |
| **多展示渠道** 同一商品池 | 多个站重复上架 | **storefront** 映射与排序 |
| Telegram / 站外引流 | 另接一堆 Bot 逻辑 | 仓库含 Telegram 相关入口与自定义收款场景（见 `src/`） |
| 个人副业 / 小团队 | 每月养机 + 安全补丁 | 边缘 + 托管库，**运维面更小** |

---

## 核心能力

与仓库代码一致，可核对 `src/services/`、`src/routes/`、`frontend/`。

### 售卖与库存

- 商品：分类、定价、封面（**R2 轻量图床**）、上架、库存展示模式
- **卡密**：批量导入 / 生成、**原子锁定与发放**，降低简单并发超卖路径
- **履约模式**：`card` · `virtual` · `link` · `code` · `invite`；发卡模式 `direct` / `manual`
- **每邮箱限购**、交付可见性（含仅邮件展示等活动向能力）
- **展示渠道（storefront）**：多入口、模板倾向、渠道侧商品可见与排序
- 履约输入字段（账号充值、预约信息等通用人工履约配置）

### 支付与资金

- 统一下单：`在线支付 / 余额 / 免费领取 / 线下确认`
- **EasyPay 兼容**在线收款（启用方式、默认方式、回调验签链路）
- **余额钱包闭环**：充值码兑换 · 在线充值订单 · 余额支付 · **CNY 单一账本**
- **运营侧用户余额**：账户列表 · 流水 · 手工调账 · 审计
- 优惠码报价；金额按币种 **最小整数单位** 存储，后台按主单位（如元）录入
- **幂等键**、限流、邮箱访问校验（余额与私有资产不「只靠邮箱串」裸查）

### 运营后台（Vue 3 SPA）

- 运营台、商品、展示渠道、卡密、订单、优惠码、充值码
- **用户余额**（账户 + 流水 + 调账）
- 充值订单、系统配置、支付配置、操作日志

### 安全与工程质量

- Cloudflare **Turnstile**、管理端 Bearer Token
- 支付凭据加密存储、关键写路径事务与审计日志
- 请求体限制、安全响应头、密钥扫描与部署脚本
- `npm run verify:delivery` 等门禁；行为以源码与测试为准

---

## 差异化亮点

这些不是口号，而是仓库里**能指到代码 / 测试**的能力：

1. **边缘优先，而不是「再装一台发卡机」**  
   Cloudflare Workers 全球边缘 + Turso libSQL：把 **运维复杂度压到最低**。

2. **卡密商家生命线：原子发卡**  
   支付成功后的库存锁定 / 发放走事务与原子更新路径（见 `issue-service`、`fulfillment-service` 及相关测试），而不是「先返回成功再碰运气扣库存」。

3. **钱包是闭环，不是半成品**  
   充值码、在线充值、余额支付、流水账、**后台可查可调**——社群预付与客服纠错场景可落地。

4. **易支付兼容，贴合国内站长习惯**  
   主路径是 **EasyPay-compatible** 通道（`src/services/payments/`），而不是假装你是全球 Stripe-only 商城。

5. **交付形态覆盖「卡密 + 虚拟资料」**  
   一卡一密、同码批次、0 元活动码、网盘/链接资料、邀请码等，用履约模式区分。

6. **多 storefront：一套库存，多个卖场门面**  
   展示渠道把「商品池」和「前台入口」解耦，减少重复上架。

7. **R2 同源读图，媒体链路轻**  
   管理端鉴权上传，公开读走同源 `/api/media/images/:filename`，不绑复杂图床中台也能上架带图商品。

8. **瑞士军刀式产品边界**  
   刻意不做 ERP / 仓配 / 多币种换汇钱包；复杂度花在 **交易闭环、对账、可运维** 上。

9. **开源与可二开**  
   MIT、TypeScript、结构清晰（`src/services` + `frontend` + `migrations` + `scripts`）。适合 fork 成自己的品牌站，而不是锁死在闭源面板。

**结果**：更少运维、可对账、可二开——在「个人与小团队数字商品售卖」这条线上把闭环做满。

---

## 技术栈

| 层 | 选型 | 为什么 |
|----|------|--------|
| 边缘运行时 | **Cloudflare Workers** | 全球边缘、无服务器运维 |
| API | **Hono** + TypeScript | 轻、快、适合 Workers |
| 数据 | **Turso / libSQL** + **Drizzle ORM** | SQLite 语义、边缘友好 |
| 前台 / 后台 | **Vue 3** SPA | 一套前端，商城 + Admin |
| 校验 | **Zod** | 边界输入校验 |
| 邮件 | Resend 等可配置链路 | 订单与交付通知 |
| 人机验证 | **Cloudflare Turnstile** | 免费档友好 |
| 媒体 | **R2** Binding 同源读图 | 轻量商品图 |

### 检索关键词（SEO / AI）

`xshop` · `自动发卡` · `卡密商城` · `卡密自动发货` · `开源虚拟商品商城` · `Workers 卡密` · `数字商品` · `激活码商城` · `CDK 商店` · `Cloudflare Workers 电商` · `Serverless 发卡` · `易支付` · `EasyPay` · `余额支付` · `充值码` · `开源发卡系统` · `Turso` · `libSQL` · `Hono` · `Vue3 管理后台` · `R2 商品图` · `MIT 开源商城` · `digital goods storefront` · `license key delivery` · `auto card key shop` · `Cloudflare Workers ecommerce`

建议在 GitHub 仓库 **Topics** 勾选相近标签（如 `cloudflare-workers`、`digital-goods`、`ecommerce`、`hono`、`vue`、`typescript`），便于发现。

---

## 快速开始

```bash
git clone https://github.com/qwdingyu/xshop.git
cd xshop

npm install
npm run db:migrate
npm run frontend:build
npm run dev
```

| 入口 | 地址 |
|------|------|
| 前台商城 | `http://localhost:8787` |
| 管理后台 | `http://localhost:8787/admin`（使用你配置的 `ADMIN_TOKEN`） |

### 部署到生产

准备：

1. [Cloudflare](https://dash.cloudflare.com/) 账号  
2. [Turso](https://turso.tech/) 数据库  
3. 域名可选（也可用 `*.workers.dev`）  

```bash
CLOUDFLARE_API_TOKEN="cfat_xxx" \
TURSO_URL="libsql://your-db.turso.io" \
TURSO_TOKEN="your-turso-token" \
npm run deploy:full
```

部署后打开 `https://<your-worker>.workers.dev/admin` 完成商品、支付与库存配置。  
Worker 名称、R2 桶名等以仓库内 **`wrangler.jsonc`** 为准（默认可与配置文件中的 name / `bucket_name` 一致，可按需改名）。

> **诚实声明**：免费额度、计费与配额以 Cloudflare / Turso / 支付通道**官方文档**为准。本仓库**不承诺**「永久零成本、无限流量」。

---

## 环境变量

| 变量 | 必需 | 说明 |
|------|:----:|------|
| `TURSO_URL` | ✅ | Turso / libSQL 连接 |
| `TURSO_TOKEN` | ✅ | 数据库 Token |
| `ADMIN_TOKEN` | ✅ | 管理后台登录凭证 |
| `CREDENTIALS_ENCRYPTION_KEY` | ✅ | 支付等凭据 AES 密钥（64 hex） |
| `CLOUDFLARE_API_TOKEN` | 部署 | Cloudflare API Token |
| `APP_ORIGIN` | 生产 | 站点公网 Origin |

本地可参考 `.dev.vars.example`（若仓库中存在）。**切勿**把真实密钥提交进 Git。

---

## 商品图片 R2

封面与渠道 Logo 使用轻量 **R2 Bucket**：管理端鉴权上传，公开读走同源 `/api/media/images/:filename`。  
不需要 Cloudflare Images、R2 Access Key 浏览器直传或额外媒体域名即可闭环。

账户需先在 Dashboard **启用 R2**；再创建与 **`wrangler.jsonc` 中 `bucket_name` 一致**的 Bucket。当前模板默认示例：

```bash
# 以下名称须与 wrangler.jsonc 的 r2_buckets[].bucket_name 一致
npx wrangler r2 bucket create cf-shop-public-media
npx wrangler r2 bucket info cf-shop-public-media --json
```

本地 `wrangler dev` 默认用本地 R2 模拟；生产必须确认远程 Bucket 已创建。

---

## 公开 API 边界

适合二次开发与 AI agent 对接时的**安全边界摘要**：

| 接口意图 | 要点 |
|----------|------|
| `POST /api/coupons/quote` | 按稳定 `storefrontId + productId` 报价；0 元基础商品不走优惠码 |
| `POST /api/pay/unified` | 统一创建在线 / 余额 / 免费 / 线下订单；需稳定 `storefrontId` + `Idempotency-Key` |
| `POST /api/pay/offline/cancel` | 仅取消仍未付款且未提交线下确认的订单 |
| `POST /api/orders/lookup` | 邮箱验证后返回最近订单**脱敏摘要**，不含卡密与订单 Token |
| 余额 / 充值相关 | 先验邮箱归属，再读余额或重放幂等结果 |
| `GET /api/media/images/:filename` | 只读系统生成的不可变 key；无列表、无任意路径、无公开写 |

浏览器不为交付持久化订单 Token；精确交付依赖短时凭证与服务端状态。

---

## 目录结构

```
xshop/
├── src/                 # Workers：路由、服务、支付、schema、Telegram 相关
├── frontend/            # Vue 3 商城 + 管理后台
├── shared/              # 前后端共享（金额、策略、履约契约等）
├── migrations/          # SQL 迁移
├── scripts/             # 部署、迁移、冒烟、校验
├── public/              # 静态资源同步目标
└── wrangler.jsonc       # Workers / R2 等绑定
```

---

## 设计原则

1. **小而美**：优先闭环与可运维，不堆中台模块。  
2. **余额账本 CNY 单一币种**：商品可有币种字段与展示脚手架；余额支付与钱包不对非 CNY 乱开。  
3. **金额整数最小单位存储**，界面用主单位录入与展示（系统配置金额项 `unit=cents`；约定见 `docs/050_金额单位存储与界面主单位闭环_2026-07-24.md`，门禁 `npm run verify:money-units`）。  
4. **代码与测试即契约**：关键行为以 `src/`、`shared/`、测试与本 README 为准。  
5. **可验证**：类型检查、单测、密钥扫描、架构与轻量原则校验脚本可组合执行。

若你在找：

- **Cloudflare Workers 发卡 / Workers 虚拟商品**
- **开源卡密商城 / 开源自动发卡系统**
- **Serverless 数字商品店 / EasyPay 自动发货**
- **Turso Hono Vue 电商模板**

——这个仓库就是为这类意图准备的。

---

## FAQ

<details>
<summary><strong>xshop 是免费的吗？</strong></summary>

软件本身 **MIT 开源、可免费使用与商用**。运行时消耗 Cloudflare、Turso、邮件与支付通道的资源，费用以各服务商为准。仓库不保证「永久零成本」。
</details>

<details>
<summary><strong>支持易支付 / 码支付类通道吗？</strong></summary>

支持 **EasyPay 兼容** Provider（见 `src/services/payments/`）。具体服务商需满足兼容协议与回调验签要求；配置项与回调路径以代码与管理后台支付配置为准。
</details>

<details>
<summary><strong>能卖实体商品、发快递吗？</strong></summary>

**不定位实体仓配**。核心是数字商品、卡密、虚拟资料与履约字段。实体物流请使用专业电商系统。
</details>

<details>
<summary><strong>支持多币种钱包吗？</strong></summary>

商品侧可有币种相关字段与展示脚手架；**余额账本当前为 CNY 单一币种**。不做多币种实时换汇钱包，避免半吊子资金系统。
</details>

<details>
<summary><strong>和「飞鱼小铺」等 PHP 发卡站比有什么不同？</strong></summary>

技术路线不同：xshop 是 **Workers 边缘 + TypeScript + Vue**，强调 **Serverless、可审计、余额闭环、storefront 渠道**。能力边界以本仓库代码为准；不做无依据的「全面碾压」宣传。
</details>

<details>
<summary><strong>和闭源商业发卡 SaaS 有何不同？</strong></summary>

**自托管 + MIT**：代码在你手里，无平台强制抽成；支付通道与云资源费用由你与服务商结算。代价是你需要自己完成部署、配置与运维。
</details>

<details>
<summary><strong>适合高并发大促吗？</strong></summary>

关键路径有事务、幂等与限流设计。但它仍是 **轻量商城**，不是无限水平扩展的超大中台。极端流量请自行压测与扩容策略评估。
</details>

<details>
<summary><strong>AI / Cursor / Claude 能直接基于本仓库二开吗？</strong></summary>

可以。README + TypeScript 类型 + 服务层结构 + 测试脚本为 agent 提供了较完整上下文。建议先读本页「核心能力 / API 边界 / 环境变量」，再改 `src/services` 与 `frontend`。
</details>

---

## 质量门禁

| 类型 | 命令 / 位置 |
|------|-------------|
| 类型检查 | `npm run type-check` |
| 单测 | `npm test` |
| 密钥扫描 | `npm run security:scan` |
| 交付门禁组合 | `npm run verify:delivery`（类型、测试、前端构建、架构与轻量原则等） |
| 部署 | `npm run deploy:full` 及 `scripts/` 下编号脚本 |

建议上线前至少跑通：`verify:delivery` 与你环境上的 smoke 脚本。

---

## 贡献与许可

### 贡献

- Issue / PR 欢迎：修 bug、补测试、打磨 README 与部署脚本。  
- 提需求时请说明：是否在**免费档**、支付通道、是否纯卡密场景，便于对齐「轻量」边界。  

### License

[MIT](./LICENSE) © 2026 xshop contributors

可商用、可修改、可私有部署；保留许可证声明即可。  
**没有平台强制抽成**——支付通道与云厂商费用由你与服务商结算。

---

### 如果你觉得有用

给仓库点一个 **Star**，让更多需要「**Cloudflare Workers 自动发卡 / 开源卡密商城 / Serverless 虚拟商品**」的人与 AI 工具能发现它。

**xshop** — *Open-source digital goods & auto card-key shop on Cloudflare Workers.*
