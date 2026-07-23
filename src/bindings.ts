import type { DbType } from "./db/client";
export {
  FULFILLMENT_MODES,
  ISSUE_MODES,
  type FulfillmentMode,
  type IssueMode,
} from "../shared/product-contract";

export type Bindings = {
  // Turso 数据库连接（必填）
  TURSO_URL: string;
  TURSO_TOKEN?: string;
  ASSETS: Fetcher;
  // 商品封面和展示渠道 Logo 的公开图片存储；只允许管理端写入。
  PRODUCT_MEDIA: R2Bucket;
  // 生产环境必须通过 wrangler secret put 设置；本地开发通过 .dev.vars 提供。
  ADMIN_TOKEN?: string;
  // Telegram 管理员一次性登录链接的专用签名密钥，不得复用数据库或 Bot 凭据。
  JWT_SECRET?: string;
  // Turnstile 开启后，后端校验必须配置 Secret Key。
  TURNSTILE_SECRET_KEY?: string;
  // Turnstile 开启后，前端渲染必须配置 Site Key。
  TURNSTILE_SITE_KEY?: string;
  // 仅供远程 smoke 使用：开启后仍必须带 x-smoke-admin-token 且匹配 ADMIN_TOKEN 才能绕过 Turnstile。
  ALLOW_TURNSTILE_BYPASS_FOR_SMOKE?: string;
  // 用于把真实 IP 哈希化后写入 request_logs，避免日志里保存明文 IP。
  RATE_LIMIT_SALT?: string;
  // 生成 lookupUrl 时使用的正式站点域名。
  APP_ORIGIN?: string;
  // Resend API Key，用于订单发卡后邮件通知买家。通过 wrangler secret put 配置。
  RESEND_API_KEY?: string;
  // Resend 已验证的发件域名（如 "xshop contributors <noreply@users.noreply.github.com>"），未配置时使用默认值。
  EMAIL_FROM?: string;
  // ── 易支付兼容通道（包括 ZPay 等聚合网关）──
  EASYPAY_PID?: string;
  EASYPAY_KEY?: string;
  EASYPAY_API_BASE?: string;   // 易支付接口基础地址，如 https://zpayz.cn
  EASYPAY_RETURN_URL?: string;
  // ── Telegram Bot（新增）──
  TG_BOT_TOKEN?: string;
  TG_OWNER_ID?: string;
  // ── 凭据加密密钥（Web 管理后台支付配置必需）──
  // AES-256-GCM 主密钥，64 字符 hex（32 字节 / 256 bit）。
  // 配置后，支付 Provider 的凭据可加密存入 systemConfig 表，
  // 通过管理后台 Web UI 管理，不再需要 wrangler secret put。
  CREDENTIALS_ENCRYPTION_KEY?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    // 中间件保证 db 一定已初始化（非 undefined）；
    // health 路由在 DB 不可用时 db 为 undefined，由路由自行降级处理。
    db: DbType | undefined;
    // ExecutionContext，用于 ctx.waitUntil() 异步邮件发送（节省请求 CPU 时间）
    executionCtx: ExecutionContext<unknown>;
  };
};
