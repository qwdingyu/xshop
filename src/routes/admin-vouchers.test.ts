import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../bindings";
import { adminVoucherRoute } from "./admin-vouchers";

const listVoucherCodes = vi.fn();
const generateVoucherCodes = vi.fn();
const revokeVoucherCodes = vi.fn();
const listRechargeOrders = vi.fn();
const listUserBalances = vi.fn();
const adjustUserBalance = vi.fn();
const writeAdminAudit = vi.fn();

vi.mock("../services/voucher-service", () => ({
  generateVoucherCodes: (...args: unknown[]) => generateVoucherCodes(...args),
  getVoucherStats: vi.fn(),
  listBalanceTransactions: vi.fn(),
  listUserBalances: (...args: unknown[]) => listUserBalances(...args),
  adjustUserBalance: (...args: unknown[]) => adjustUserBalance(...args),
  listVoucherCodes: (...args: unknown[]) => listVoucherCodes(...args),
  revokeVoucherCodes: (...args: unknown[]) => revokeVoucherCodes(...args),
}));

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: (...args: unknown[]) => writeAdminAudit(...args),
}));

vi.mock("../services/recharge-service", () => ({
  listRechargeOrders: (...args: unknown[]) => listRechargeOrders(...args),
}));

vi.mock("../lib/security", () => ({
  getIpHash: vi.fn().mockResolvedValue("ip-hash"),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api/admin", adminVoucherRoute);
  return app;
}

beforeEach(() => {
  listVoucherCodes.mockReset();
  listVoucherCodes.mockResolvedValue({ total: 0, items: [] });
  generateVoucherCodes.mockReset();
  generateVoucherCodes.mockResolvedValue(["VCH-TESTCODE"]);
  revokeVoucherCodes.mockReset();
  revokeVoucherCodes.mockResolvedValue(0);
  listRechargeOrders.mockReset();
  listRechargeOrders.mockResolvedValue({ total: 0, items: [] });
  listUserBalances.mockReset();
  listUserBalances.mockResolvedValue({ total: 0, items: [] });
  adjustUserBalance.mockReset();
  writeAdminAudit.mockReset();
  writeAdminAudit.mockResolvedValue(undefined);
});

describe("adminVoucherRoute", () => {
  it("clamps voucher list pagination to safe bounds", async () => {
    const res = await createApp().request("/api/admin/vouchers/list?limit=-10&offset=-5");

    expect(res.status).toBe(200);
    expect(listVoucherCodes).toHaveBeenCalledWith({}, {
      status: undefined,
      batchId: undefined,
      search: undefined,
      limit: 1,
      offset: 0,
    });
    await expect(res.json()).resolves.toMatchObject({ ok: true, total: 0, items: [], limit: 1, offset: 0 });
  });

  it("rejects unsupported voucher status filters instead of returning a misleading empty page", async () => {
    const res = await createApp().request("/api/admin/vouchers/list?status=unknown");

    expect(res.status).toBe(400);
    expect(listVoucherCodes).not.toHaveBeenCalled();
  });

  it("passes normalized search and batch filters to the paginated service", async () => {
    listVoucherCodes.mockResolvedValueOnce({ total: 1, items: [{ code: "VCH-ABCDEF23" }] });

    const res = await createApp().request("/api/admin/vouchers/list?search=vch-abc&batchId=batch-1&limit=20&offset=40");

    expect(res.status).toBe(200);
    expect(listVoucherCodes).toHaveBeenCalledWith({}, {
      status: undefined,
      batchId: "batch-1",
      search: "vch-abc",
      limit: 20,
      offset: 40,
    });
    await expect(res.json()).resolves.toMatchObject({ total: 1, limit: 20, offset: 40 });
  });

  it("rejects malformed revoke payloads before calling the service", async () => {
    const res = await createApp().request("/api/admin/vouchers/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codes: [123, "short"] }),
    });

    expect(res.status).toBe(400);
    expect(revokeVoucherCodes).not.toHaveBeenCalled();
  });

  it("deduplicates and normalizes voucher codes before revoking", async () => {
    revokeVoucherCodes.mockResolvedValueOnce(1);
    const res = await createApp().request("/api/admin/vouchers/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codes: ["vch-abcdef23", " VCH-ABCDEF23 "] }),
    });

    expect(res.status).toBe(200);
    expect(revokeVoucherCodes).toHaveBeenCalledWith({}, ["VCH-ABCDEF23"]);
  });

  it("rejects invalid expiration timestamps during generation", async () => {
    const res = await createApp().request("/api/admin/vouchers/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 1, amountCents: 100, batchId: "batch-1", expiresAt: "tomorrow" }),
    });

    expect(res.status).toBe(400);
    expect(generateVoucherCodes).not.toHaveBeenCalled();
  });

  it("validates and forwards recharge order filters", async () => {
    const res = await createApp().request("/api/admin/recharge-orders?email=Buyer%40Example.com&status=pending&limit=20&offset=20");

    expect(res.status).toBe(200);
    expect(listRechargeOrders).toHaveBeenCalledWith({}, {
      email: "Buyer@Example.com",
      status: "pending",
      limit: 20,
      offset: 20,
    });
  });

  it("lists user balances with email and positiveOnly filters", async () => {
    listUserBalances.mockResolvedValueOnce({
      total: 1,
      items: [{ email: "buyer@example.com", balanceCents: 1200, totalDepositedCents: 2000, totalSpentCents: 800, updatedAt: "2026-01-01T00:00:00.000Z" }],
    });

    const res = await createApp().request("/api/admin/user-balances?email=buyer&positiveOnly=1&limit=20&offset=0");

    expect(res.status).toBe(200);
    expect(listUserBalances).toHaveBeenCalledWith({}, {
      email: "buyer",
      positiveOnly: true,
      limit: 20,
      offset: 0,
    });
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      total: 1,
      items: [expect.objectContaining({ email: "buyer@example.com", balanceCents: 1200 })],
    });
  });

  it("rejects zero-amount balance adjustments", async () => {
    const res = await createApp().request("/api/admin/user-balances/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", amountCents: 0, note: "test note" }),
    });

    expect(res.status).toBe(400);
    expect(adjustUserBalance).not.toHaveBeenCalled();
  });

  it("credits balance and writes admin audit on successful adjustment", async () => {
    adjustUserBalance.mockResolvedValueOnce({
      email: "buyer@example.com",
      amountCents: 500,
      balanceCents: 1500,
    });

    const res = await createApp().request("/api/admin/user-balances/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Buyer@Example.com", amountCents: 500, note: "客服补偿" }),
    });

    expect(res.status).toBe(200);
    expect(adjustUserBalance).toHaveBeenCalledWith({}, "Buyer@Example.com", 500, "客服补偿");
    expect(writeAdminAudit).toHaveBeenCalledWith({}, expect.objectContaining({
      action: "adjust_user_balance",
      targetType: "user_balance",
      targetId: "buyer@example.com",
    }));
  });

  it("returns 400 when service rejects debit for insufficient balance", async () => {
    adjustUserBalance.mockRejectedValueOnce(new Error("余额不足或账户不存在，无法扣款"));

    const res = await createApp().request("/api/admin/user-balances/adjust", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", amountCents: -9999, note: "误充回收" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
    expect(writeAdminAudit).not.toHaveBeenCalled();
  });
});
