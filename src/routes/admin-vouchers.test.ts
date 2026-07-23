import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../bindings";
import { adminVoucherRoute } from "./admin-vouchers";

const listVoucherCodes = vi.fn();
const generateVoucherCodes = vi.fn();
const revokeVoucherCodes = vi.fn();
const listRechargeOrders = vi.fn();

vi.mock("../services/voucher-service", () => ({
  generateVoucherCodes: (...args: unknown[]) => generateVoucherCodes(...args),
  getVoucherStats: vi.fn(),
  listBalanceTransactions: vi.fn(),
  listVoucherCodes: (...args: unknown[]) => listVoucherCodes(...args),
  revokeVoucherCodes: (...args: unknown[]) => revokeVoucherCodes(...args),
}));

vi.mock("../services/audit-service", () => ({
  writeAdminAudit: vi.fn().mockResolvedValue(undefined),
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
});
