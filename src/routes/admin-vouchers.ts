import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../bindings";
import { fail, getDb, ok, safeJsonBody } from "../lib/http";
import { getIpHash } from "../lib/security";
import { writeAdminAudit } from "../services/audit-service";
import {
  generateVoucherCodes,
  getVoucherStats,
  listBalanceTransactions,
  listVoucherCodes,
  revokeVoucherCodes,
} from "../services/voucher-service";
import { listRechargeOrders } from "../services/recharge-service";

export const adminVoucherRoute = new Hono<AppEnv>();

function queryInt(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

const generateVoucherSchema = z.object({
  count: z.number().int().min(1).max(500),
  amountCents: z.number().int().min(1).max(99999999),
  batchId: z.string().trim().min(1).max(80),
  expiresAt: z.string().datetime({ offset: true }).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

const voucherListFilterSchema = z.object({
  status: z.enum(["active", "used", "expired", "revoked"]).optional(),
  batchId: z.string().trim().max(80).optional(),
  search: z.string().trim().max(80).optional(),
});

const revokeVoucherSchema = z.object({
  codes: z.array(z.string().trim().min(8).max(80)).min(1).max(200),
});

const balanceTransactionQuerySchema = z.object({
  email: z.string().trim().email().optional().or(z.literal("")),
  type: z.enum(["voucher_redeem", "recharge", "order_spend", "refund", "adjustment"]).optional().or(z.literal("")),
  referenceType: z.string().trim().max(40).optional().or(z.literal("")),
  referenceId: z.string().trim().max(120).optional().or(z.literal("")),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const rechargeOrderQuerySchema = z.object({
  email: z.string().trim().email().optional().or(z.literal("")),
  status: z.enum(["pending", "paid", "expired", "failed"]).optional().or(z.literal("")),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * 批量生成充值码。
 * 每个充值码面值一致，适用于第三方收款后批量交付。
 */
adminVoucherRoute.post("/vouchers/generate", async (c) => {
  const db = getDb(c);
  const body = generateVoucherSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "参数无效", 400, body.error.flatten());

  const { count, amountCents, batchId, expiresAt, notes } = body.data;
  const codes = await generateVoucherCodes(
    db, count, amountCents, batchId,
    expiresAt || null, notes,
  );

  await writeAdminAudit(db, {
    action: "generate_vouchers",
    targetType: "voucher",
    targetId: batchId,
    metadata: { count, amountCents, batchId },
    ipHash: await getIpHash(c),
  });

  return ok(c, {
    count: codes.length,
    batchId,
    codes,
    message: `已生成 ${codes.length} 张充值码`,
  });
});

/** 查询充值码列表（支持分页和状态过滤）。 */
adminVoucherRoute.get("/vouchers/list", async (c) => {
  const db = getDb(c);
  const filter = voucherListFilterSchema.safeParse({
    status: c.req.query("status") || undefined,
    batchId: c.req.query("batchId") || undefined,
    search: c.req.query("search") || undefined,
  });
  if (!filter.success) return fail(c, "查询参数无效", 400, filter.error.flatten());
  const limit = queryInt(c.req.query("limit"), 50, 1, 200);
  const offset = queryInt(c.req.query("offset"), 0, 0, 1000000);

  const result = await listVoucherCodes(db, { ...filter.data, limit, offset });
  return ok(c, { items: result.items, total: result.total, limit, offset });
});

/** 充值码统计。 */
adminVoucherRoute.get("/vouchers/stats", async (c) => {
  const stats = await getVoucherStats(getDb(c));
  return ok(c, stats);
});

/** 余额流水查询：用于核对充值码入账、余额消费、退款和人工调账。 */
adminVoucherRoute.get("/balance-transactions", async (c) => {
  const query = balanceTransactionQuerySchema.safeParse({
    email: c.req.query("email") || "",
    type: c.req.query("type") || "",
    referenceType: c.req.query("referenceType") || "",
    referenceId: c.req.query("referenceId") || "",
    limit: c.req.query("limit") || "50",
    offset: c.req.query("offset") || "0",
  });
  if (!query.success) return fail(c, "查询参数无效", 400, query.error.flatten());

  const result = await listBalanceTransactions(getDb(c), query.data);
  return ok(c, {
    total: result.total,
    limit: query.data.limit,
    offset: query.data.offset,
    transactions: result.transactions,
  });
});

adminVoucherRoute.get("/recharge-orders", async (c) => {
  const query = rechargeOrderQuerySchema.safeParse({
    email: c.req.query("email") || "",
    status: c.req.query("status") || "",
    limit: c.req.query("limit") || "50",
    offset: c.req.query("offset") || "0",
  });
  if (!query.success) return fail(c, "查询参数无效", 400, query.error.flatten());
  const result = await listRechargeOrders(getDb(c), query.data);
  return ok(c, { ...result, limit: query.data.limit, offset: query.data.offset });
});

/** 批量作废充值码。 */
adminVoucherRoute.post("/vouchers/revoke", async (c) => {
  const db = getDb(c);
  const body = revokeVoucherSchema.safeParse(await safeJsonBody(c));
  if (!body.success) return fail(c, "请提供有效的充值码列表", 400, body.error.flatten());
  const codes = [...new Set(body.data.codes.map((code) => code.toUpperCase()))];

  const count = await revokeVoucherCodes(db, codes);

  await writeAdminAudit(db, {
    action: "revoke_vouchers",
    targetType: "voucher",
    targetId: codes.join(",").slice(0, 100),
    metadata: { count },
    ipHash: await getIpHash(c),
  });

  return ok(c, { count, message: `已作废 ${count} 张充值码` });
});
