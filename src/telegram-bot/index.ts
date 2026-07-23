/**
 * Telegram Bot 子模块 — 挂载于主 Worker 的 /tg/ 路由下
 *
 * 对标 TGPays bot.php 的核心交互，用现代 TS + Hono 重写：
 *
 *  1. Webhook 接收 Telegram 更新（消息 + 回调）
 *  2. /start → 创建订单 → 选择支付方式 → 调用易支付
 *  3. 支付成功 → 更新订单 → 推送 TG 通知
 *  4. JWT 一次性登录链接（owner 专属）
 *
 * 与主 Worker 共享 cf-shop 的 DB / Provider / 限流 / 订单服务层。
 *
 * TG 自定义订单（productId: "tg_custom"）不走商品发卡流程，
 * 仅做纯收款 + 支付完成通知，不调用 markPaidAndIssue。
 */

import { Hono } from "hono";
import type { Context } from "hono";
import { initDatabase } from "../db/database";
import type { Bindings } from "../bindings";
import { createDbProviderRegistry, createDbProviderRegistryForCallback } from "../services/payments";
import { hashOrderToken } from "../lib/token";
import { orders } from "../db/schema";
import { eq, and, inArray, or, sql } from "drizzle-orm";
import { writeOrderEvent } from "../services/audit-service";
import { escapeHtml } from "../services/email-service";
import { signJwt } from "@usethink/cf-core/auth/jwt";
import { normalizeSecurePaymentUrl } from "../lib/payment-url";
import { getClientIp } from "@usethink/cf-core";
import { formatMoney, minorToMajorString, parseMajorToMinor, tryNormalizeCurrencyCode } from "../../shared/money";

// ═══════════════════════════════════════════════════════════
// Telegram Webhook 路由
// ═══════════════════════════════════════════════════════════

export const tgBot = new Hono<{ Bindings: Bindings }>();

async function deriveTelegramWebhookSecret(botToken?: string): Promise<string> {
  // Telegram webhook secret 由 bot token 派生，不单独存储第二份密钥，减少配置漂移。
  if (!botToken) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botToken));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqualString(provided: string, expected: string): Promise<boolean> {
  // 先 hash 再比较，保证长度差异不会直接泄露给计时侧信道。
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
  }
  const providedBytes = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < providedBytes.length; index++) {
    mismatch |= providedBytes[index] ^ expectedBytes[index];
  }
  return mismatch === 0;
}

export function normalizeTelegramPaymentUrl(value: string | undefined): string {
  return normalizeSecurePaymentUrl(value);
}

function paymentRawString(raw: Record<string, unknown> | undefined, key: string): string {
  const value = raw?.[key];
  return typeof value === "string" ? value.trim() : "";
}

// ── 支付结果展示页面 —— 对标 TGPays return.php ──
tgBot.get("/result", async (c) => {
  const env = c.env;
  const orderNo = c.req.query("orderNo") || c.req.query("out_trade_no") || "";
  let dbStatus = "unknown";
  let dbAmount = "";
  let dbPayType = "易支付";

  // 有 orderNo 时查 DB 获取真实状态
  if (orderNo && env.TURSO_URL && env.TURSO_TOKEN) {
    try {
      const { db } = initDatabase({ TURSO_URL: env.TURSO_URL, TURSO_TOKEN: env.TURSO_TOKEN });
      const [order] = await db
        .select({ status: orders.status, amountCents: orders.amountCents, paymentProvider: orders.paymentProvider })
        .from(orders)
        .where(eq(orders.orderNo, orderNo))
        .limit(1);
      if (order) {
        dbStatus = order.status === "paid" || order.status === "issued" ? "TRADE_SUCCESS" : order.status;
        dbAmount = order.amountCents ? minorToMajorString(order.amountCents, "CNY") : "";
        if (order.paymentProvider === "easypay") dbPayType = "易支付";
        else if (order.paymentProvider === "alipay") dbPayType = "支付宝";
        else if (order.paymentProvider) dbPayType = order.paymentProvider;
      }
    } catch (err) {
      console.warn("[tg-result] db query failed:", err);
    }
  }

  const isSuccess = dbStatus === "TRADE_SUCCESS" || dbStatus === "paid" || dbStatus === "issued";
  const safeOrderNo = escapeHtml(orderNo || "未知");
  const safeAmount = escapeHtml(dbAmount);
  const safePayType = escapeHtml(dbPayType);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付结果</title><meta name="robots" content="noindex,nofollow">
<style>
  *{box-sizing:border-box}html,body{height:100%}
  body{margin:0;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial;
    background:radial-gradient(900px 300px at 10% -10%,#e6f0ff 0,transparent 60%),radial-gradient(600px 240px at 120% 0%,#e8fff6 0,transparent 60%),#f6f7fb;
    display:flex;align-items:center;justify-content:center;padding:20px;color:#0f172a}
  .card{width:100%;max-width:460px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;
    box-shadow:0 16px 44px rgba(15,23,42,.08);padding:28px 24px;text-align:center;
    opacity:0;transform:translateY(8px) scale(.98);animation:popIn .5s ease-out forwards}
  @keyframes popIn{to{opacity:1;transform:translateY(0) scale(1)}}
  .icon-wrap{width:84px;height:84px;border-radius:50%;display:grid;place-items:center;margin:0 auto 14px;border:1px solid #e5e7eb;background:#fff}
  .icon-wrap.ok{background:#ecfdf5;border-color:#bbf7d0}.icon-wrap.err{background:#fef2f2;border-color:#fecaca}
  .draw{stroke-dasharray:100;stroke-dashoffset:100;animation:draw 700ms ease-out forwards 120ms}
  @keyframes draw{to{stroke-dashoffset:0}}
  h1{font-size:20px;margin:6px 0 6px;font-weight:700}
  p.sub{margin:0 0 14px;font-size:14px;color:#6b7280}
  .info{margin-top:12px;border:1px solid #e5e7eb;border-radius:12px;padding:14px 12px;text-align:left}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0}
  .label{width:86px;font-size:12px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase}
  .value{font-size:14px;color:#111827}
  .chip{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;background:#f8fafc;border:1px solid #e5e7eb;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace}
  .badge{font-size:12px;padding:4px 8px;border-radius:999px;border:1px solid rgba(0,0,0,.06)}
  .badge.ok{background:#ecfdf5;color:#065f46;border-color:#bbf7d0}.badge.err{background:#fef2f2;color:#7f1d1d;border-color:#fecaca}
  .foot{margin-top:10px;font-size:12px;color:#9aa3b2}
</style></head>
<body>
  <main class="card" role="main">
    <div class="icon-wrap ${isSuccess ? 'ok' : 'err'}">
      <svg width="38" height="38" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        ${isSuccess
          ? '<circle cx="12" cy="12" r="9" stroke="#16a34a" stroke-width="2" class="draw"></circle><path d="M7 12.5l3 3 7-7" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="draw"></path>'
          : '<circle cx="12" cy="12" r="9" stroke="#ef4444" stroke-width="2" class="draw"></circle><path d="M8 8l8 8M16 8l-8 8" stroke="#ef4444" stroke-width="2" stroke-linecap="round" class="draw"></path>'}
      </svg>
    </div>
    <h1>${isSuccess ? '支付成功' : '支付未完成'}</h1>
    <p class="sub">${isSuccess ? '交易已确认，我们已收到款项。' : '支付可能尚未完成，请稍后重试或联系管理员。'}</p>
    <div class="info">
      <div class="row"><div class="label">订单号</div><div class="value"><span class="chip">${safeOrderNo}</span></div></div>
      ${dbAmount ? `<div class="row"><div class="label">金额</div><div class="value"><strong>¥ ${safeAmount}</strong></div></div>` : ''}
      <div class="row"><div class="label">状态</div><div class="value"><span class="badge ${isSuccess ? 'ok' : 'err'}">${isSuccess ? '交易成功' : '等待支付'}</span></div></div>
      <div class="row"><div class="label">渠道</div><div class="value">${safePayType}</div></div>
    </div>
    <div class="foot">结果仅供参考，最终以异步通知为准</div>
  </main>
</body></html>`;

  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  return c.html(html);
});

// ── Webhook 入口 ──
tgBot.post("/webhook", async (c) => {
  const expectedSecret = await deriveTelegramWebhookSecret(c.env.TG_BOT_TOKEN);
  const providedSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!expectedSecret || !providedSecret || !await timingSafeEqualString(providedSecret, expectedSecret)) {
    return c.text("unauthorized", 401);
  }

  const body = await c.req.json() as Record<string, unknown>;
  const update = body as {
    update_id?: number;
    message?: {
      chat?: { id?: number | string; type?: string };
      from?: { id?: number | string; username?: string };
      text?: string;
    };
    callback_query?: {
      id?: string;
      message?: { chat?: { id?: number | string; type?: string }; chat_id?: number | string; message_id?: number };
      from?: { id?: number | string };
      data?: string;
    };
  };

  // 1. 文本消息
  if (update.message) {
    await handleTextMessage(update.message, c);
  }

  // 2. 回调按钮
  if (update.callback_query) {
    await handleCallback(update.callback_query, c);
  }

  return c.text("ok");
});

// ── 设置 Webhook ──
tgBot.post("/set-webhook", async (c) => {
  const env = c.env;
  if (!env.ADMIN_TOKEN) return c.json({ ok: false, error: "ADMIN_TOKEN 未配置" }, 503);
  const authorization = c.req.header("Authorization") || "";
  const providedAdminToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!providedAdminToken || !await timingSafeEqualString(providedAdminToken, env.ADMIN_TOKEN)) {
    return c.json({ ok: false, error: "未授权" }, 401);
  }
  c.header("Cache-Control", "no-store");
  // 从 APP_ORIGIN 提取实际部署域名，/tg/webhook 为 Webhook 入口路径
  const origin = env.APP_ORIGIN || "";
  if (!origin) {
    return c.json({ ok: false, error: "APP_ORIGIN 未配置，无法设置 Webhook" });
  }
  const webhookSecret = await deriveTelegramWebhookSecret(env.TG_BOT_TOKEN);
  if (!webhookSecret) {
    return c.json({ ok: false, error: "TG_BOT_TOKEN 未配置，无法设置 Webhook" }, 503);
  }
  const url = `${origin}/tg/webhook`;
  const tgUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook`;
  const webhookParams = new URLSearchParams({
    url,
    allowed_updates: JSON.stringify(["message", "callback_query"]),
    secret_token: webhookSecret,
  });
  const res = await fetch(`${tgUrl}?${webhookParams.toString()}`, { method: "POST" });
  const data = await res.json();

  // 同时注册命令菜单（对标 TGPays bot.php 的 setMyCommands）
  // 让用户在 Telegram 输入 / 时能看到命令提示
  const commandsRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "start", description: "显示欢迎菜单" },
        { command: "pay", description: "快速支付 /pay 88.66" },
        { command: "status", description: "查询最近订单" },
        { command: "login", description: "后台登录（管理员）" },
      ],
    }),
  });
  const commandsData = await commandsRes.json();

  return c.json({ webhook: data, commands: commandsData });
});

// ═══════════════════════════════════════════════════════════
// 文本消息处理
// ═══════════════════════════════════════════════════════════

async function handleTextMessage(
  message: {
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string; username?: string };
    text?: string;
  },
  c: { env: Bindings },
) {
  const env = c.env;
  if (!env.TURSO_URL || !env.TURSO_TOKEN) {
    console.warn("[tg] DB not configured, skipping message");
    return;
  }

  const { db } = initDatabase({ TURSO_URL: env.TURSO_URL, TURSO_TOKEN: env.TURSO_TOKEN });
  const chatId = message.chat?.id;
  const senderId = message.from?.id;
  const text = (message.text || "").trim();
  if (!chatId) return;
  if (message.chat?.type && message.chat.type !== "private") {
    await tgSendText(env, chatId, "请私聊机器人完成支付和订单查询。");
    return;
  }
  if (senderId !== undefined && String(senderId) !== String(chatId)) return;

  // /start — 显示帮助菜单
  if (text === "/start") {
    await sendStartMenu(env, chatId);
    return;
  }

  // /login（仅 owner）
  if (text === "/login") {
    if (String(chatId) !== String(env.TG_OWNER_ID)) {
      await tgSendText(env, chatId, "🚫 无权限登录后台，仅限管理员使用。");
      return;
    }
    const link = await generateLoginLink(chatId, env);
    await tgSendHtml(env, chatId,
      `🔐 <b>后台登录授权</b>\n\n请点击以下链接登录后台（<b>60秒</b> 内有效）：\n<a href="${link}">👉 点击进入后台</a>`,
    );
    return;
  }

  // /status — 查询用户最近的订单状态
  if (text === "/status") {
    const buyerContact = `tg:${chatId}`;
    const recentOrders = await db
      .select({
        orderNo: orders.orderNo,
        amountCents: orders.amountCents,
        status: orders.status,
        createdAt: orders.createdAt,
        paymentProvider: orders.paymentProvider,
      })
      .from(orders)
      .where(and(
        eq(orders.buyerContact, buyerContact),
        eq(orders.productId, "tg_custom"),
      ))
      .orderBy(sql`${orders.createdAt} DESC`)
      .limit(5);

    if (recentOrders.length === 0) {
      await tgSendText(env, chatId, "📭 您还没有任何订单记录。");
      return;
    }

    const statusMap: Record<string, string> = {
      pending: "⏳ 待支付",
      paid: "✅ 已支付",
      issued: "📦 已发卡",
      expired: "⌛ 已过期",
      closed: "❌ 已关闭",
      failed: "💥 失败",
    };

    const lines = recentOrders.map((o, i) => {
      const amount = minorToMajorString(o.amountCents, "CNY");
      const statusText = statusMap[o.status] || o.status;
      return `${i + 1}. <code>${o.orderNo}</code> — ¥${amount} — ${statusText}`;
    });

    await tgSendHtml(env, chatId,
      `📋 <b>最近订单（最多5条）</b>\n\n${lines.join("\n")}\n\n` +
      `💡 使用 <code>/pay 金额</code> 创建新订单`,
    );
    return;
  }

  // /pay 88.66
  if (text.startsWith("/pay")) {
    const parts = text.split(/\s+/);
    if (parts.length >= 2 && /^\d{1,3}(\.\d{1,2})?$/.test(parts[1])) {
      await processAmount(chatId, parts[1], env, db);
    } else {
      await tgSendText(env, chatId, "格式错误，请使用：/pay 金额（如 /pay 88.66）");
    }
    return;
  }

  // 直接输入金额
  if (/^\d{1,3}(\.\d{1,2})?$/.test(text)) {
    await processAmount(chatId, text, env, db);
    return;
  }
}

/**
 * 发送 /start 欢迎菜单，列出可用命令
 * 对标 TGPays bot.php 中 start 的回复信息
 */
async function sendStartMenu(env: Bindings, chatId: number | string) {
  const keyboard: InlineKeyboard = [
    [{ text: "💳 支付 /pay", callback_data: "enter_amount" }],
  ];
  const isOwner = String(chatId) === String(env.TG_OWNER_ID);
  if (isOwner) {
    keyboard.push([{ text: "🔐 后台登录 /login", callback_data: "admin_login" }]);
  }

  await tgSendHtml(env, chatId,
    `🚀 <b>欢迎使用 TGPays 机器人！</b>\n\n` +
    `📌 <b>可用命令：</b>\n` +
    `• <code>/pay 金额</code> — 创建支付订单\n` +
    `• <code>/start</code> — 显示此菜单\n` +
    (isOwner ? `• <code>/login</code> — 生成后台登录链接\n` : "") +
    `\n💡 您也可以直接输入金额数字（如 <code>88.66</code>）快速发起支付。`,
    keyboard,
  );
}

async function processAmount(
  chatId: number | string,
  amountMajor: string,
  env: Bindings,
  db: ReturnType<typeof initDatabase>["db"],
) {
  let amountCents: number;
  try {
    amountCents = parseMajorToMinor(amountMajor, "CNY");
  } catch {
    await tgSendText(env, chatId, "⚠️ 金额必须为 0~999 间的数字，最多两位小数");
    return;
  }
  if (amountCents <= 0 || amountCents > 99900) {
    await tgSendText(env, chatId, "⚠️ 金额必须为 0~999 间的数字，最多两位小数");
    return;
  }

  // 检查该用户是否有未支付的 pending 订单（15分钟内有效）
  // 避免用户重复创建多个订单造成混乱
  const buyerContact = `tg:${chatId}`;
  const now = new Date().toISOString();
  const existingPending = await db
    .select({ orderNo: orders.orderNo, amountCents: orders.amountCents, createdAt: orders.createdAt })
    .from(orders)
    .where(and(
      eq(orders.buyerContact, buyerContact),
      eq(orders.status, "pending"),
      eq(orders.productId, "tg_custom"),
      sql`${orders.expiresAt} > ${now}`,
    ))
    .orderBy(sql`${orders.createdAt} DESC`)
    .limit(1);

  if (existingPending.length > 0) {
    const existing = existingPending[0];
    const existingAmount = minorToMajorString(existing.amountCents, "CNY");
    await tgSendHtml(env, chatId,
      `⚠️ <b>您有一笔未支付的订单</b>\n\n` +
      `🆔 订单号：<code>${existing.orderNo}</code>\n` +
      `💰 金额：<code>${existingAmount}</code> 元\n` +
      `⏰ 创建时间：${existing.createdAt}\n\n` +
      `请先完成或关闭该订单后再创建新订单。`,
    );
    return;
  }

  const orderNo = createPayOrderNo();
  const orderId = crypto.randomUUID();
  // 金额由原始字符串精确解析为最小单位，避免浮点金额进入支付与回调核验。
  const orderToken = crypto.randomUUID();
  const orderTokenHash = await hashOrderToken(orderToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15分钟

  // 创建订单记录
  await db.insert(orders).values({
    id: orderId,
    orderNo,
    productId: "tg_custom",
    orderSource: "telegram",
    storefrontId: null,
    buyerContact: `tg:${chatId}`,
    buyerEmail: "",
    amountCents,
    discountCents: 0,
    currency: "CNY",
    status: "pending",
    issueMode: "manual",
    paymentMethod: "tg_easypay",
    paymentProvider: "easypay",
    paymentRef: "",
    orderTokenHash,
    issuedCardId: null,
    campaignCode: "",
    referralCode: "",
    couponCode: "",
    ipHash: "",
    userAgent: "TelegramBot",
    createdAt: new Date().toISOString(),
    expiresAt,
  });

  await writeOrderEvent(db, orderId, "created", "Telegram Bot 订单创建", { chatId, amountCents, currency: "CNY" });

  // 发送支付方式选择
  await sendChoosePayUI(env, chatId, orderNo, amountCents);
}

// ═══════════════════════════════════════════════════════════
// 回调按钮处理
// ═══════════════════════════════════════════════════════════

async function handleCallback(
  callback: {
    id?: string;
    message?: { chat?: { id?: number | string; type?: string }; chat_id?: number | string; message_id?: number };
    from?: { id?: number | string };
    data?: string;
  },
  c: Context<{ Bindings: Bindings }>,
) {
  const env = c.env;
  const data = callback.data || "";
  // Telegram webhook payload uses callback_query.message.chat.id. Keep
  // chat_id compatibility for historical fixtures and custom gateways.
  const chatId = callback.message?.chat?.id ?? callback.message?.chat_id;
  const actorId = callback.from?.id;
  const messageId = callback.message?.message_id;

  if (!chatId) return;

  // answerCallbackQuery
  const answer = async (text: string, showAlert = false) => {
    if (callback.id) {
      await tgRequest(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text,
        show_alert: showAlert,
      });
    }
  };

  if (callback.message?.chat?.type && callback.message.chat.type !== "private") {
    await answer("请私聊机器人完成支付操作", true);
    return;
  }
  if (actorId !== undefined && String(actorId) !== String(chatId)) {
    await answer("操作人与订单会话不一致", true);
    return;
  }

  // enter_amount
  if (data === "enter_amount") {
    await tgSendText(env, chatId, "💰 请输入您要支付的金额，例如：88.66");
    await answer("请输入金额");
    return;
  }

  // cancel_order — 用户取消尚未支付的订单（按钮数据格式：cancel_order:orderNo）
  if (data === "cancel_order") {
    await deleteMsg(env, chatId, messageId);
    await answer("订单已取消");
    return;
  }

  // 解析 action:order_no
  const colonIdx = data.indexOf(":");
  if (colonIdx === -1) {
    await answer("无效操作");
    return;
  }

  const action = data.slice(0, colonIdx);
  const orderNo = data.slice(colonIdx + 1);

  // close_order / cancel_order — 更新数据库订单状态为 closed
  // close_order 是支付方式选择后的关闭按钮，cancel_order 是支付方式选择页的取消按钮
  // 两者功能相同：将 pending 订单标记为 closed
  if (action === "close_order" || action === "cancel_order") {
    let didClose = false;
    try {
      const { db } = initDatabase({ TURSO_URL: c.env.TURSO_URL!, TURSO_TOKEN: c.env.TURSO_TOKEN! });
      const [order] = await db.select({
        id: orders.id,
        status: orders.status,
        productId: orders.productId,
        paymentMethod: orders.paymentMethod,
        paymentProvider: orders.paymentProvider,
        buyerContact: orders.buyerContact,
      }).from(orders).where(eq(orders.orderNo, orderNo)).limit(1);
      if (
        order?.status === "pending" &&
        order.productId === "tg_custom" &&
        order.paymentMethod === "tg_easypay" &&
        order.paymentProvider === "easypay" &&
        order.buyerContact === `tg:${chatId}`
      ) {
        // 关闭使用完整订单属性做 CAS，避免同一 orderNo 被并发支付成功后又被按钮关闭覆盖。
        const closed = await db.update(orders)
          .set({ status: "closed" })
          .where(and(
            eq(orders.id, order.id),
            eq(orders.status, "pending"),
            eq(orders.productId, "tg_custom"),
            eq(orders.paymentMethod, "tg_easypay"),
            eq(orders.paymentProvider, "easypay"),
            eq(orders.buyerContact, `tg:${chatId}`),
          ));
        didClose = closed.rowsAffected > 0;
        if (didClose) {
          await writeOrderEvent(db, order.id, "closed", "用户通过 TG Bot 关闭订单");
        }
      }
    } catch (err) {
      console.warn("[tg] close_order db update failed:", err);
    }
    if (!didClose) {
      await answer("订单状态已变化或不属于当前会话，无法关闭", true);
      return;
    }
    // cancel_order 删除支付方式选择页消息，并发送"订单已取消"消息
    if (action === "cancel_order") {
      await deleteMsg(env, chatId, messageId);
      await tgSendText(env, chatId, "❌ 订单已取消");
    }
    await answer("订单已关闭");
    return;
  }

  // pay_alipay / pay_wxpay
  if (action === "pay_alipay" || action === "pay_wxpay") {
    const payType = action === "pay_alipay" ? "alipay" : "wxpay";
    await editMsg(env, chatId, messageId, "已选择：" + (payType === "alipay" ? "支付宝" : "微信") + "，正在生成二维码...");

    // 查询订单
    if (!c.env.TURSO_URL || !c.env.TURSO_TOKEN) {
      await answer("数据库未配置", true);
      return;
    }
    const { db } = initDatabase({ TURSO_URL: c.env.TURSO_URL, TURSO_TOKEN: c.env.TURSO_TOKEN });
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.orderNo, orderNo))
      .limit(1);

    if (!order) {
      await answer("订单不存在！", true);
      return;
    }

    if (
      order.productId !== "tg_custom" ||
      order.paymentMethod !== "tg_easypay" ||
      order.buyerContact !== `tg:${chatId}`
    ) {
      await answer("订单不属于当前 Telegram 支付流程", true);
      return;
    }

    if (order.status !== "pending") {
      await answer("订单状态不可支付", true);
      return;
    }

    // 检查订单是否已过期（15分钟有效期）
    if (order.expiresAt && new Date(order.expiresAt).getTime() < Date.now()) {
      // 尝试将过期订单标记为 expired
      try {
        const { db: expireDb } = initDatabase({ TURSO_URL: c.env.TURSO_URL!, TURSO_TOKEN: c.env.TURSO_TOKEN! });
        const expired = await expireDb
          .update(orders)
          .set({ status: "expired" })
          .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
          .returning({ id: orders.id });
        if (expired.length === 0) {
          await answer("订单状态已变化，请重新查询", true);
          return;
        }
        await writeOrderEvent(expireDb, order.id, "expired", "TG Bot 支付时检测到订单已过期");
      } catch { /* 非关键路径 */ }
      await editMsg(env, chatId, messageId, "⏰ 该订单已过期（15分钟有效期），请重新发起支付。");
      await answer("订单已过期，请重新下单", true);
      return;
    }

    // schema 保证 orderNo 为 text().notNull()，此处追加非空断言避让 drizzle 类型推理
    const tradeOrderNo: string = order.orderNo!;

    // 调用易支付
    const registry = await createDbProviderRegistry(env, db, env.CREDENTIALS_ENCRYPTION_KEY);
    // TG 回调固定接收 EasyPay 通知，不能选全局优先级中的其他支付渠道。
    const provider = registry.get("easypay");
    if (!provider) {
      await answer("易支付未配置", true);
      return;
    }

    try {
      const result = await provider.createPayment({
        orderNo: tradeOrderNo,
        amountCents: order.amountCents,
        currency: order.currency,
        // 回调路径与 tgBot.post("/callback") 路由一致
        // 当 tg-bot 挂载在主 Worker 的 /tg/ 下时，实际路径为 /tg/callback
        notifyUrl: `${getAppOrigin(env)}/tg/callback`,
        // 跳转路径：支付完成后用户浏览器重定向到结果页
        // 兼容 easypay 和部分渠道的 return 机制
        returnUrl: `${getAppOrigin(env)}/tg/result?orderNo=${encodeURIComponent(tradeOrderNo)}`,
        metadata: {
          subject: "Telegram支付",
          payType,
          // Telegram Bot 支付发起请求来自 Telegram Webhook/按钮交互链路。
          // 这里传给 EasyPay 的是 Worker 可见来源 IP，不声称它等于买家设备公网 IP。
          clientIp: getClientIp(c),
        },
      });

      const raw = result.raw || {};
      const qrContent = paymentRawString(raw, "qrContent") || paymentRawString(raw, "qrcode");
      const qrImageUrl = normalizeTelegramPaymentUrl(paymentRawString(raw, "qrImageUrl") || paymentRawString(raw, "img"));
      const redirectUrl = normalizeTelegramPaymentUrl(result.redirectUrl);
      const qrContentUrl = normalizeTelegramPaymentUrl(qrContent);
      const legacyQrUrl = result.qrCode && result.qrCode !== qrContent
        ? normalizeTelegramPaymentUrl(result.qrCode)
        : "";
      const paymentUrl = redirectUrl || qrContentUrl;
      const paymentQrPhotoUrl = qrImageUrl || legacyQrUrl;
      if (!paymentUrl && !paymentQrPhotoUrl && !qrContent) {
        throw new Error("支付渠道未返回可展示的付款入口");
      }

      // 构建按钮
      const buttons = paymentUrl
        ? [[
          { text: "✅ 前往支付", url: paymentUrl },
          { text: "❌ 关闭订单", callback_data: `close_order:${orderNo}` },
        ]]
        : [[{ text: "❌ 关闭订单", callback_data: `close_order:${orderNo}` }]];

      const caption = `💳 <b>支付信息</b>\n\n💰 <b>金额：</b><code>${minorToMajorString(order.amountCents, "CNY")}</code> 元\n💱 <b>货币：</b><code>CNY</code>\n🆔 <b>订单号：</b><code>${orderNo}</code>\n⏰ <b>有效期：</b><b>15分钟</b>\n\n📌 <b>请扫描二维码或点击按钮完成付款：</b>`;

      // 删除"正在生成"消息，发送支付消息
      await deleteMsg(env, chatId, messageId);

      if (paymentQrPhotoUrl || qrContent) {
        const qrUrl = paymentQrPhotoUrl
          || `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrContent)}`;
        const sent = await tgSendPhoto(env, chatId, qrUrl, caption, buttons);
        if (!sent.ok) throw new Error(sent.description || sent.error || "Telegram 支付二维码发送失败");
      } else {
        const sent = await tgSendText(env, chatId, paymentUrl, buttons);
        if (!sent.ok) throw new Error(sent.description || sent.error || "Telegram 支付链接发送失败");
      }
    } catch (err) {
      console.error("[tg] payment failed:", err);
      await answer("支付请求失败：" + (err instanceof Error ? err.message : "unknown"), true);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 支付回调处理（易支付异步通知）
// ═══════════════════════════════════════════════════════════

tgBot.all("/callback", async (c) => {
  const env = c.env;
  const db = initDatabase({ TURSO_URL: env.TURSO_URL!, TURSO_TOKEN: env.TURSO_TOKEN! }).db;

  // EasyPay/ZPAY 官方通知方法为 GET；部分兼容网关或旧测试会 POST 表单。
  // 两种请求只差参数来源，验签和金额校验必须走同一条路径。
  const params = c.req.method === "GET"
    ? Object.fromEntries(
        Object.entries(c.req.queries()).map(([key, values]) => [key, values[0] || ""]),
      )
    : Object.fromEntries(new URLSearchParams(await c.req.text()).entries());

  // 验签
  // 回调必须能验证已创建订单的上游通知；禁用渠道只阻止新建 TG 支付，不阻断既有订单验签。
  const registry = await createDbProviderRegistryForCallback(env, db, env.CREDENTIALS_ENCRYPTION_KEY);
  const provider = registry.get("easypay");
  if (!provider) {
    return c.text("easypay not configured", 500);
  }

  try {
    const callbackResult = await provider.verifyCallback(params as Record<string, string>);
    const orderNo = callbackResult.orderNo;

    // 查订单
    const [order] = await db.select().from(orders).where(eq(orders.orderNo, orderNo)).limit(1);
    if (!order) return c.text("order not found", 404);

    if (
      order.productId !== "tg_custom" ||
      order.paymentMethod !== "tg_easypay" ||
      order.paymentProvider !== "easypay"
    ) {
      await writeOrderEvent(db, order.id, "payment_rejected", "订单不属于 Telegram EasyPay 收款流程", {
        productId: order.productId,
        paymentMethod: order.paymentMethod,
        paymentProvider: order.paymentProvider,
      });
      return c.text("fail", 400);
    }

    // 金额校验
    if (callbackResult.amountCents !== order.amountCents) {
      console.warn(`[tg-callback] amount mismatch: ${callbackResult.amountCents} !== ${order.amountCents}`);
      await writeOrderEvent(db, order.id, "payment_rejected", "Telegram 支付回调金额不匹配", {
        provider: "easypay",
        callbackAmountCents: callbackResult.amountCents,
        orderAmountCents: order.amountCents,
        trade_no: callbackResult.providerTradeNo,
      });
      return c.text("fail", 400);
    }

    // Telegram 收款与商城订单共享同一支付信任边界：币种缺失、未知或不一致都不得入账。
    const callbackCurrency = tryNormalizeCurrencyCode(callbackResult.currency);
    const orderCurrency = tryNormalizeCurrencyCode(order.currency);
    if (!callbackCurrency || !orderCurrency || callbackCurrency !== orderCurrency) {
      await writeOrderEvent(db, order.id, "payment_rejected", "Telegram 支付回调币种不匹配", {
        provider: "easypay",
        expected: orderCurrency || "",
        received: callbackCurrency || "",
        trade_no: callbackResult.providerTradeNo,
      });
      return c.text("fail", 400);
    }

    // 幂等确认必须同时匹配支付渠道与流水。不同流水不能被静默确认，否则平台会停止重试未入账付款。
    if (order.status === "paid" || order.status === "issued") {
      const samePayment = order.paymentProvider === "easypay"
        && order.paymentRef === callbackResult.providerTradeNo;
      if (samePayment) return c.text("success");

      if (!order.paymentRef) {
        const backfilled = await db.update(orders)
          .set({
            paymentProvider: "easypay",
            paymentRef: callbackResult.providerTradeNo,
            paidAt: order.paidAt || callbackResult.paidAt || new Date().toISOString(),
          })
          .where(and(
            eq(orders.id, order.id),
            or(eq(orders.status, "paid"), eq(orders.status, "issued")),
            eq(orders.paymentProvider, "easypay"),
            eq(orders.paymentRef, ""),
          ))
          .returning({ id: orders.id });
        if (backfilled.length > 0) return c.text("success");
      }

      await writeOrderEvent(db, order.id, "payment_rejected", "Telegram 支付回调流水与已支付订单不一致", {
        provider: "easypay",
        trade_no: callbackResult.providerTradeNo,
        recorded_trade_no: order.paymentRef || "",
        status: order.status,
      });
      return c.text("fail", 409);
    }

    if (!["pending", "expired", "closed"].includes(order.status)) {
      await writeOrderEvent(db, order.id, "payment_rejected", "Telegram 支付回调对应订单状态不可收款", {
        provider: "easypay",
        status: order.status,
        trade_no: callbackResult.providerTradeNo,
      });
      return c.text("fail", 409);
    }

    // Telegram 自定义订单是纯收款：已验签且金额匹配的真实付款必须记账，
    // 即使用户先关闭消息或网关在订单过期后才送达通知。
    const nowStr = callbackResult.paidAt || new Date().toISOString();
    let updated = await db.update(orders)
      .set({ status: "paid", paymentProvider: "easypay", paymentRef: callbackResult.providerTradeNo, paidAt: nowStr })
      .where(and(
        eq(orders.id, order.id),
        inArray(orders.status, ["pending", "expired", "closed"]),
        eq(orders.productId, "tg_custom"),
        eq(orders.paymentMethod, "tg_easypay"),
        eq(orders.paymentProvider, "easypay"),
        or(eq(orders.paymentRef, callbackResult.providerTradeNo), eq(orders.paymentRef, "")),
      ))
      .returning({ id: orders.id });

    if (updated.length === 0) {
      const [currentOrder] = await db
        .select({
          status: orders.status,
          paymentProvider: orders.paymentProvider,
          paymentRef: orders.paymentRef,
        })
        .from(orders)
        .where(eq(orders.id, order.id))
        .limit(1);
      const samePayment = currentOrder?.paymentProvider === "easypay"
        && currentOrder.paymentRef === callbackResult.providerTradeNo;

      if ((currentOrder?.status === "paid" || currentOrder?.status === "issued") && samePayment) {
        return c.text("success");
      }

      if (currentOrder?.status === "expired" || currentOrder?.status === "closed") {
        updated = await db.update(orders)
          .set({ status: "paid", paymentProvider: "easypay", paymentRef: callbackResult.providerTradeNo, paidAt: nowStr })
          .where(and(
            eq(orders.id, order.id),
            inArray(orders.status, ["expired", "closed"]),
            eq(orders.productId, "tg_custom"),
            eq(orders.paymentMethod, "tg_easypay"),
            eq(orders.paymentProvider, "easypay"),
            or(eq(orders.paymentRef, callbackResult.providerTradeNo), eq(orders.paymentRef, "")),
          ))
          .returning({ id: orders.id });
      }

      if (updated.length === 0) {
        await writeOrderEvent(db, order.id, "payment_rejected", "Telegram 支付回调写入时订单状态已变更", {
          provider: "easypay",
          trade_no: callbackResult.providerTradeNo,
          recorded_trade_no: currentOrder?.paymentRef || "",
          status: currentOrder?.status || "missing",
        });
        return c.text("fail", 409);
      }
    }

    try {
      await writeOrderEvent(db, order.id, "paid", "Telegram 支付成功", {
        provider: "easypay",
        trade_no: callbackResult.providerTradeNo,
      });
    } catch (eventError) {
      // 订单支付状态已经持久化，辅助审计失败不能让支付平台继续重试已完成的收款。
      console.warn("[tg-callback] failed to write paid event:", eventError);
    }

    // TG 自定义订单（productId: "tg_custom"）无对应商品/库存，不走 markPaidAndIssue
    // 仅标记已支付并发送通知，无需发卡
    // 对标 TGPays notify.php 的逻辑：更新订单状态 + TG 消息推送

    // 通知用户
    const tgId = order.buyerContact.replace("tg:", "");
    if (tgId) {
      const amountFmt = minorToMajorString(order.amountCents, "CNY");
      const notificationText = `🎉 <b>支付结果通知</b>\n\n✅ 您的支付已成功！\n\n💳 <b>订单号：</b><code>${orderNo}</code>\n💰 <b>支付金额：</b>${amountFmt} 元\n💱 <b>货币：</b>CNY\n\n感谢您的使用，我们已收到您的付款。`;
      let notification = await tgSendHtml(env, tgId, notificationText);
      if (!notification?.ok) {
        notification = await tgSendHtml(env, tgId, notificationText);
      }
      if (!notification?.ok) {
        try {
          await writeOrderEvent(db, order.id, "notification_failed", "Telegram 支付成功通知发送失败", {
            channel: "telegram",
            description: notification?.description || notification?.error || "unknown",
          });
        } catch (eventError) {
          console.warn("[tg-callback] failed to record notification failure:", eventError);
        }
      }
    }

    return c.text("success");
  } catch (err) {
    console.warn("[tg-callback] verify failed:", err);
    return c.text("fail", 400);
  }
});

// ═══════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════

function getAppOrigin(env: Bindings): string {
  // APP_ORIGIN 是必填环境变量（在 wrangler.jsonc 中配置），
  // 降级逻辑仅用于本地开发时未配置的情况
  return env.APP_ORIGIN || `https://${env.TG_BOT_TOKEN?.split(":")[0] || "localhost"}.workers.dev`;
}

function createPayOrderNo(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `TG${ts}${rand}`;
}

/** 生成 JWT 一次性登录链接（60 秒有效）
 *
 * 使用 @usethink/cf-core/auth/jwt 的 signJwt 签名，
 * 签名 API：signJwt(userId, email, secret, expirySeconds)
 * sub=tgId, email=""，只允许使用专用 JWT_SECRET，禁止复用数据库或 Bot 凭据。
 */
async function generateLoginLink(tgId: number | string, env: Bindings): Promise<string> {
  if (!env.JWT_SECRET) {
    throw new Error("JWT_SECRET 未配置，无法生成管理员登录链接");
  }
  const token = await signJwt(
    String(tgId),
    "",
    env.JWT_SECRET,
    60, // 60 秒过期
  );
  return `${getAppOrigin(env)}/admin?jwt=${token}`;
}

/** 发送"选择支付方式"UI */
async function sendChoosePayUI(env: Bindings, chatId: number | string, orderNo: string, amountCents: number) {
  const text = `🧾 <b>支付订单创建完成！</b>\n\n💰 <b>金额：</b><code>${formatMoney(amountCents, "CNY")}</code>\n💱 <b>货币：</b><code>CNY</code>\n👤 <b>ID：</b><code>${chatId}</code>\n\n📌 <b>请选择下方支付方式：</b>`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: "💳 支付宝", callback_data: `pay_alipay:${orderNo}` },
        { text: "💚 微信", callback_data: `pay_wxpay:${orderNo}` },
      ],
      [{ text: "❌ 取消", callback_data: `cancel_order:${orderNo}` }],
    ],
  };

  await tgRequest(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: JSON.stringify(keyboard),
  });
}

type TelegramApiResult = {
  ok: boolean;
  description?: string;
  error?: string;
  [key: string]: unknown;
};

/** 发送 Telegram API 请求 */
async function tgRequest(env: Bindings, method: string, params: Record<string, unknown>): Promise<TelegramApiResult> {
  const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const payload: unknown = await res.json();
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "invalid Telegram API response" };
    }
    return payload as TelegramApiResult;
  } catch (err) {
    console.error("[tg-request] failed:", err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Telegram Inline Keyboard 按钮行 = 一维数组（一行内的按钮）
 * Telegram Inline Keyboard = 二维数组（多行按钮）
 * 每行为 Record<string, unknown> 传递 text + url/callback_data 等字段
 */
type InlineKeyboardRow = Record<string, unknown>[];
type InlineKeyboard = InlineKeyboardRow[];

/** 快捷方法 */
async function tgSendText(env: Bindings, chatId: number | string, text: string, buttons?: InlineKeyboard) {
  return tgRequest(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: buttons ? JSON.stringify({ inline_keyboard: buttons }) : undefined });
}

async function tgSendHtml(env: Bindings, chatId: number | string, text: string, buttons?: InlineKeyboard) {
  return tgRequest(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: buttons ? JSON.stringify({ inline_keyboard: buttons }) : undefined });
}

async function tgSendPhoto(env: Bindings, chatId: number | string, photo: string, caption: string, buttons?: InlineKeyboard) {
  return tgRequest(env, "sendPhoto", { chat_id: chatId, photo, caption, parse_mode: "HTML", reply_markup: buttons ? JSON.stringify({ inline_keyboard: buttons }) : undefined });
}

async function deleteMsg(env: Bindings, chatId: number | string, messageId?: number) {
  if (!messageId) return;
  return tgRequest(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function editMsg(env: Bindings, chatId: number | string, messageId: number | undefined, text: string) {
  if (!messageId) return;
  return tgRequest(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" });
}

// ═══════════════════════════════════════════════════════════
// 路由已通过 src/index.ts mount('/tg', tgBot) 挂载到主 Worker
// 不再单独导出 Worker 入口
// ═══════════════════════════════════════════════════════════
