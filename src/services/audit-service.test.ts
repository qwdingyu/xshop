/**
 * 审计日志服务单元测试
 *
 * 测试覆盖：
 * - writeOrderEvent：写入订单事件日志
 * - writeAdminAudit：写入管理员审计日志
 *
 * 两类审计函数都是"写入即忘"模式——写入失败不阻塞主流程。
 * 测试验证正确的 insert 调用参数和元数据 JSON 序列化。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbType } from "../db/client";
import { writeOrderEvent, writeAdminAudit } from "./audit-service";

// ── 测试辅助 ──────────────────────────────────────────────────────────────

type InsertCall = {
  table: unknown;
  data: Record<string, unknown>;
};

function createMockAuditDb(): DbType & { insertCalls: InsertCall[] } {
  const insertCalls: InsertCall[] = [];

  const mockInsertResult = {
    catch: (handler: (err: unknown) => void) => {
      return { then: (resolve: () => void) => resolve(), catch: handler };
    },
    then: (resolve: (value: unknown) => void) => {
      resolve({ rowsAffected: 1 });
      return { catch: () => {} };
    },
  };

  return {
    insertCalls,

    insert: (table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        insertCalls.push({ table, data });
        return mockInsertResult;
      },
    }),

    select: () => ({
      from: () => Promise.resolve([]),
      where: () => Promise.resolve([]),
    }),

    update: () => ({
      set: () => ({
        where: () => Promise.resolve({ rowsAffected: 1 }),
      }),
    }),

    run: () => Promise.resolve({ rows: [] }),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
  } as unknown as DbType & { insertCalls: InsertCall[] };
}

function createRejectingAuditDb(): DbType {
  return {
    insert: () => ({
      values: () => Promise.reject(new Error("audit storage unavailable")),
    }),
  } as unknown as DbType;
}

// ── writeOrderEvent 测试 ────────────────────────────────────────────────

describe("writeOrderEvent", () => {
  let db: DbType & { insertCalls: InsertCall[] };

  beforeEach(() => {
    db = createMockAuditDb();
  });

  it("写入订单事件日志包含所有必需字段", async () => {
    await writeOrderEvent(db, "order-123", "issued", "订单已发卡", { cardId: "card-001" });

    expect(db.insertCalls).toHaveLength(1);
    const call = db.insertCalls[0];
    expect(call.data).toMatchObject({
      orderId: "order-123",
      type: "issued",
      message: "订单已发卡",
    });
    expect(call.data.id).toBeDefined();
    expect(typeof call.data.id).toBe("string");
    expect(call.data.createdAt).toBeDefined();
    expect(typeof call.data.createdAt).toBe("string");
  });

  it("元数据被序列化为 JSON 字符串", async () => {
    await writeOrderEvent(db, "order-456", "created", "订单创建", { fulfillmentMode: "card" });

    const call = db.insertCalls[0];
    expect(call.data.metadataJson).toBe(JSON.stringify({ fulfillmentMode: "card" }));
  });

  it("不传 metadata 时序列化为空对象", async () => {
    await writeOrderEvent(db, "order-789", "expired", "订单过期");

    const call = db.insertCalls[0];
    expect(call.data.metadataJson).toBe("{}");
  });

  it("不传 message 时默认为空字符串", async () => {
    await writeOrderEvent(db, "order-000", "paid");

    const call = db.insertCalls[0];
    expect(call.data.message).toBe("");
  });

  it("写入不同的事件类型", async () => {
    const events = [
      { type: "created", msg: "订单已创建" },
      { type: "paid", msg: "支付成功" },
      { type: "issued", msg: "已发卡" },
      { type: "expired", msg: "已过期" },
      { type: "issue_failed", msg: "发卡失败" },
      { type: "canceled", msg: "已取消" },
    ];

    for (const evt of events) {
      await writeOrderEvent(db, "order-evt", evt.type, evt.msg);
    }

    expect(db.insertCalls).toHaveLength(events.length);
    for (let i = 0; i < events.length; i++) {
      expect(db.insertCalls[i].data.type).toBe(events[i].type);
      expect(db.insertCalls[i].data.message).toBe(events[i].msg);
    }
  });

  it("订单事件写入失败时不阻塞业务主流程", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(writeOrderEvent(createRejectingAuditDb(), "order-fail", "paid")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("[audit] failed to write order event:", expect.any(Error));
    warn.mockRestore();
  });
});

// ── writeAdminAudit 测试 ────────────────────────────────────────────────

describe("writeAdminAudit", () => {
  let db: DbType & { insertCalls: InsertCall[] };

  beforeEach(() => {
    db = createMockAuditDb();
  });

  it("写入管理员审计日志包含所有必需字段", async () => {
    await writeAdminAudit(db, {
      action: "update_product",
      targetType: "product",
      targetId: "prod-001",
      metadata: { oldPrice: 1000, newPrice: 1500 },
      ipHash: "abc123hash",
    });

    expect(db.insertCalls).toHaveLength(1);
    const call = db.insertCalls[0];
    expect(call.data.action).toBe("update_product");
    expect(call.data.targetType).toBe("product");
    expect(call.data.targetId).toBe("prod-001");
    expect(call.data.metadataJson).toBe(JSON.stringify({ oldPrice: 1000, newPrice: 1500 }));
    expect(call.data.ipHash).toBe("abc123hash");
    expect(call.data.id).toBeDefined();
    expect(call.data.createdAt).toBeDefined();
  });

  it("不传目标信息时使用空字符串", async () => {
    await writeAdminAudit(db, { action: "login" });

    const call = db.insertCalls[0];
    expect(call.data.action).toBe("login");
    expect(call.data.targetType).toBe("");
    expect(call.data.targetId).toBe("");
    expect(call.data.metadataJson).toBe("{}");
    expect(call.data.ipHash).toBe("");
  });

  it("只传 action 可以正常写入", async () => {
    await writeAdminAudit(db, { action: "logout" });

    const call = db.insertCalls[0];
    expect(call.data.action).toBe("logout");
  });

  it("管理员审计写入失败时不覆盖已完成的后台操作结果", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(writeAdminAudit(createRejectingAuditDb(), { action: "update_product" })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("[audit] failed to write admin audit:", expect.any(Error));
    warn.mockRestore();
  });

  it("写入多种管理员操作类型", async () => {
    const actions = [
      { action: "create_product", targetType: "product", targetId: "p-1" },
      { action: "batch_import_cards", targetType: "card", targetId: "" },
      { action: "update_system_config", targetType: "config", targetId: "rate_limit" },
      { action: "manual_issue", targetType: "order", targetId: "o-1" },
      { action: "admin_login", targetType: "", targetId: "" },
    ];

    for (const act of actions) {
      await writeAdminAudit(db, act);
    }

    expect(db.insertCalls).toHaveLength(actions.length);
    for (let i = 0; i < actions.length; i++) {
      expect(db.insertCalls[i].data.action).toBe(actions[i].action);
      expect(db.insertCalls[i].data.targetType).toBe(actions[i].targetType);
      expect(db.insertCalls[i].data.targetId).toBe(actions[i].targetId);
    }
  });
});
