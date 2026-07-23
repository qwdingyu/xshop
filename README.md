# cf-shop — 发卡商城

> 零服务器、零月租的数字商品售卖平台，运行在 Cloudflare Workers 上。

---

## 痛点

- 卖个虚拟商品（卡密、激活码、VIP 会员、电子资料），还得买 VPS 搭网站、配数据库、处理运维？
- Shopify 等平台每笔抽成，月租还贵，小本生意利润全被吃掉？
- 想用 Serverless，但 DynamoDB 贵、MongoDB Atlas 免费额度小、传统 SQL 数据库在边缘环境跑不起来？
- 用户下单后还要手动发卡、手动查账？

**cf-shop 用 Cloudflare Workers 免费额度 + Turso libSQL 免费 5GB，把这一切归零。**

---

## 它解决什么

| 场景 | 以前 | 用 cf-shop |
|------|------|------------|
| 卖游戏卡密 / 充值码 | 买 VPS → 装 PHP → 配 MySQL → 手动发卡 | 部署到 Workers → 自动发卡 |
| 卖电子资料 / 课程 | 网盘分享 → 链接过期 → 售后纠纷 | 购买后邮件自动发送 |
| 小额数字商品 | 平台抽成 5-15% | 零平台费，只付 Stripe 手续费 |
| 自己用的充值码系统 | 自己写管理后台 | 自带完整管理后台 |
| 个人创业者 | 每月花 50-200 元养服务器 | 免费额度足够跑起来 |

---

## 特点

**零基础设施**
- 部署在 Cloudflare Workers 边缘网络，全球 300+ 节点
- 数据库用 Turso (libSQL)，SQLite 兼容，免费 5GB
- 没有 VPS、没有 Docker、没有 Kubernetes

**免费额度足够起步**
- **Cloudflare Workers**：每天 10 万请求，足以支撑小型店铺
- **Turso**：免费 5GB 存储 + 10 亿行读取/月
- 用户量大了再按需升级，初期成本为零

**内置商城完整闭环**
- 商品管理（分类、定价、库存、发货模式）
- 卡密导入与自动发货
- 优惠码 / 折扣码
- 在线支付（EasyPay 兼容协议）
- 余额支付与充值
- 线下收款确认
- 邮件通知（Resend）
- 管理后台（Vue 3 SPA）
- 操作日志与审计

**安全开箱即用**
- Cloudflare Turnstile 人机验证（免费，替代 CAPTCHA）
- 请求限流与幂等控制
- 支付配置加密存储
- 管理后台 Bearer Token 认证
- 数据库定时加密备份

---

## 快速开始

```bash
# 克隆项目
git clone https://github.com/your-username/cf-shop.git
cd cf-shop

# 安装依赖
npm install

# 初始化数据库
npm run db:migrate

# 构建前端
npm run frontend:build

# 启动开发服务器
npm run dev
# 前台: http://localhost:8787
# 后台: http://localhost:8787/admin
```

### 部署到生产环境

需要准备：
- [Cloudflare 账号](https://dash.cloudflare.com/)（免费）
- [Turso 账号](https://turso.tech/)（免费 5GB）
- 一个域名（可选，也可以用 `.workers.dev` 子域名）

```bash
CLOUDFLARE_API_TOKEN="cfat_xxx" \
TURSO_URL="libsql://your-db.turso.io" \
TURSO_TOKEN="your-turso-token" \
npm run deploy:full
```

部署完成后，访问 `https://your-project.workers.dev/admin`，用 `ADMIN_TOKEN` 登录管理后台。

---

## 技术栈

| 层 | 选型 |
|----|------|
| 运行时 | Cloudflare Workers |
| 框架 | Hono（TypeScript） |
| 数据库 | Turso (libSQL) |
| ORM | Drizzle ORM |
| 前端 | Vue 3 + Vue Router |
| 邮件 | Resend |
| 人机验证 | Cloudflare Turnstile |

---

## 目录结构

```
cf-shop/
├── src/                    # Worker 服务端源码
│   ├── index.ts            # 入口路由
│   ├── db/                 # 数据库 Schema 与迁移
│   ├── lib/                # 工具库（HTTP、限流、缓存、配置）
│   ├── routes/             # API 路由
│   └── services/           # 业务逻辑
├── frontend/               # Vue 3 前端
├── migrations/             # SQL 迁移文件
├── scripts/                # 部署与运维脚本
└── docs/                   # 设计文档与复盘
```

---

## 环境变量

| 变量 | 必需 | 说明 |
|------|:----:|------|
| `TURSO_URL` | ✅ | Turso 数据库连接地址 |
| `TURSO_TOKEN` | ✅ | Turso 认证 Token |
| `ADMIN_TOKEN` | ✅ | 管理后台登录凭证 |
| `CREDENTIALS_ENCRYPTION_KEY` | ✅ | AES-256 加密密钥（64位 hex） |
| `CLOUDFLARE_API_TOKEN` | 部署时 | Cloudflare API Token |

---

## 商品图片存储

商品封面和展示渠道 Logo 使用一个轻量 R2 Bucket，管理端经 Worker 鉴权上传，公开图片通过同源 `/api/media/images/:filename` 读取。当前方案不需要 Cloudflare Images、R2 Access Key、自定义媒体域名或浏览器直传 CORS。

Cloudflare 账户必须先在 Dashboard 中启用一次 R2；未启用时 Wrangler 会返回 `10042: Please enable R2 through the Cloudflare Dashboard`，CLI 无法绕过该账户级前置步骤。启用后创建与 `wrangler.jsonc` 一致的 Bucket：

```bash
npx wrangler r2 bucket create cf-shop-public-media
npx wrangler r2 bucket info cf-shop-public-media --json
```

本地 `npx wrangler dev` 默认使用 `.wrangler/state` 中的本地 R2 模拟，不会写入远程 Bucket。生产部署前必须确认远程 Bucket 已创建，否则带 `PRODUCT_MEDIA` Binding 的部署不能形成可用闭环。

---

## 公开 API 边界

- `POST /api/coupons/quote`：按稳定 `storefrontId + productId` 报价；基础 0 元商品不进入优惠码流程。
- `POST /api/pay/unified`：统一创建在线、余额、免费或线下支付订单；请求体必须包含稳定 `storefrontId`，并通过 `Idempotency-Key` 请求头提交强随机幂等键。
- `POST /api/pay/offline/cancel`：仅取消仍未付款且尚未提交线下付款确认的订单。
- `POST /api/orders/lookup`：按邮箱查单，邮箱验证码验证通过后只返回最近订单的脱敏摘要，不返回卡密、下载地址或订单 Token。
- 余额查询、余额支付和在线充值均先验证邮箱归属，再读取余额或重放幂等结果，避免仅凭邮箱地址访问私有资产。
- `GET /api/media/images/:filename`：只读取系统生成的不可变图片 key，不提供对象列表、任意路径读取或公开写入。

浏览器只在当前付款会话中保存必要的恢复参数，不再把订单 Token 持久化；精确订单交付内容通过短时凭证和服务端状态校验获取。

---

## License

MIT © 2026 [Your Name]

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
