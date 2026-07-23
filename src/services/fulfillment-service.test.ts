import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbType } from "../db/client";
import {
  fulfillCardInventory,
  fulfillCardInventoryItems,
  lockFulfillmentInventory,
  lockFulfillmentInventoryItems,
  releaseFulfilledInventory,
  rollbackFulfilledInventory,
  toVirtualFulfillmentResult,
} from "./fulfillment-service";

const issueMocks = vi.hoisted(() => ({
  issueAvailableCard: vi.fn(),
  lockCardForOrder: vi.fn(),
  releaseIssuedCard: vi.fn(),
  rollbackIssuedCard: vi.fn(),
  releaseLockedCardByOrder: vi.fn(),
}));

vi.mock("./issue-service", () => ({
  issueAvailableCard: (...args: unknown[]) => issueMocks.issueAvailableCard(...args),
  lockCardForOrder: (...args: unknown[]) => issueMocks.lockCardForOrder(...args),
  releaseIssuedCard: (...args: unknown[]) => issueMocks.releaseIssuedCard(...args),
  rollbackIssuedCard: (...args: unknown[]) => issueMocks.rollbackIssuedCard(...args),
  releaseLockedCardByOrder: (...args: unknown[]) => issueMocks.releaseLockedCardByOrder(...args),
}));

describe("fulfillment-service", () => {
  const db = {} as DbType;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("通过卡密适配器发放并生成前端交付结构", async () => {
    issueMocks.issueAvailableCard.mockResolvedValueOnce({
      id: "card-1",
      accountLabel: "账号",
      deliverySecret: "SECRET",
      deliveryNote: "备注",
    });

    const result = await fulfillCardInventory(db, "order-1", "product-1");

    expect(issueMocks.issueAvailableCard).toHaveBeenCalledWith(db, "order-1", "product-1", undefined, undefined);
    expect(result).toEqual({
      mode: "card",
      card: {
        id: "card-1",
        accountLabel: "账号",
        deliverySecret: "SECRET",
        deliveryNote: "备注",
      },
      delivery: {
        accountLabel: "账号",
        deliverySecret: "SECRET",
        deliveryNote: "备注",
      },
    });
  });

  it("锁定库存时只暴露履约语义，不泄漏底层卡密结构", async () => {
    issueMocks.lockCardForOrder.mockResolvedValueOnce({ id: "card-2" });

    const result = await lockFulfillmentInventory(db, "order-2", "product-2", "2026-06-24T10:00:00.000Z");

    expect(issueMocks.lockCardForOrder).toHaveBeenCalledWith(db, "order-2", "product-2", "2026-06-24T10:00:00.000Z");
    expect(result).toEqual({ mode: "card", inventoryId: "card-2" });
  });

  it("locks every requested inventory item for multi-quantity orders", async () => {
    issueMocks.lockCardForOrder
      .mockResolvedValueOnce({ id: "card-1" })
      .mockResolvedValueOnce({ id: "card-2" })
      .mockResolvedValueOnce({ id: "card-3" });

    const result = await lockFulfillmentInventoryItems(db, "order-quantity", "product-1", "2026-06-24T10:00:00.000Z", 3);

    expect(result).toEqual({ mode: "card", inventoryIds: ["card-1", "card-2", "card-3"] });
    expect(issueMocks.lockCardForOrder).toHaveBeenCalledTimes(3);
    expect(issueMocks.lockCardForOrder).toHaveBeenNthCalledWith(1, db, "order-quantity", "product-1", "2026-06-24T10:00:00.000Z");
    expect(issueMocks.lockCardForOrder).toHaveBeenNthCalledWith(3, db, "order-quantity", "product-1", "2026-06-24T10:00:00.000Z");
  });

  it("releases partial locks when multi-quantity locking cannot reserve the full quantity", async () => {
    issueMocks.lockCardForOrder
      .mockResolvedValueOnce({ id: "card-1" })
      .mockResolvedValueOnce(null);

    const result = await lockFulfillmentInventoryItems(db, "order-short", "product-1", "2026-06-24T10:00:00.000Z", 2);

    expect(result).toBeNull();
    expect(issueMocks.lockCardForOrder).toHaveBeenCalledTimes(2);
    expect(issueMocks.releaseLockedCardByOrder).toHaveBeenCalledWith(db, "order-short");
  });

  it("issues every requested card for direct multi-quantity orders", async () => {
    issueMocks.issueAvailableCard
      .mockResolvedValueOnce({ id: "card-1", accountLabel: "账号1", deliverySecret: "SECRET-1", deliveryNote: "备注1" })
      .mockResolvedValueOnce({ id: "card-2", accountLabel: "账号2", deliverySecret: "SECRET-2", deliveryNote: "备注2" });

    const result = await fulfillCardInventoryItems(db, "order-direct", "product-1", 2, "buyer@example.test", "buyer@example.test");

    expect(result?.cards?.map((card) => card.id)).toEqual(["card-1", "card-2"]);
    expect(result?.delivery.deliverySecret).toBe("SECRET-1");
    expect(issueMocks.issueAvailableCard).toHaveBeenCalledTimes(2);
    expect(issueMocks.issueAvailableCard).toHaveBeenNthCalledWith(2, db, "order-direct", "product-1", "buyer@example.test", "buyer@example.test");
  });

  it("rolls back partial issues when direct multi-quantity issuing cannot fulfill the full quantity", async () => {
    issueMocks.issueAvailableCard
      .mockResolvedValueOnce({ id: "card-1", accountLabel: "账号1", deliverySecret: "SECRET-1", deliveryNote: "备注1" })
      .mockResolvedValueOnce(null);

    const result = await fulfillCardInventoryItems(db, "order-direct-short", "product-1", 2, "buyer@example.test");

    expect(result).toBeNull();
    expect(issueMocks.issueAvailableCard).toHaveBeenCalledTimes(2);
    expect(issueMocks.rollbackIssuedCard).toHaveBeenCalledWith(db, "card-1");
  });

  it("代理释放和回滚操作，保留现有原子发卡实现", async () => {
    await releaseFulfilledInventory(db, "card-3", "order-3");
    await rollbackFulfilledInventory(db, "card-4");

    expect(issueMocks.releaseIssuedCard).toHaveBeenCalledWith(db, "card-3", "order-3");
    expect(issueMocks.rollbackIssuedCard).toHaveBeenCalledWith(db, "card-4");
  });
});

// ── toVirtualFulfillmentResult 纯函数测试 ─────────────────────────────

describe("toVirtualFulfillmentResult", () => {
  it("返回 mode='virtual' 和传入的 delivery 结构", () => {
    const delivery = {
      accountLabel: "虚拟商品",
      deliverySecret: "交付内容说明",
      deliveryNote: "请仔细阅读使用说明",
    };
    const result = toVirtualFulfillmentResult(delivery);
    expect(result).toEqual({
      mode: "virtual",
      delivery,
    });
  });

  it("保留 delivery 中所有字段", () => {
    const delivery = {
      accountLabel: "商品标题",
      deliverySecret: "密钥内容",
      deliveryNote: "备注信息",
    };
    const result = toVirtualFulfillmentResult(delivery);
    expect(result.delivery.accountLabel).toBe("商品标题");
    expect(result.delivery.deliverySecret).toBe("密钥内容");
    expect(result.delivery.deliveryNote).toBe("备注信息");
  });

  it("不包含 card 字段（与 card 模式区分）", () => {
    const result = toVirtualFulfillmentResult({
      accountLabel: "测试",
      deliverySecret: "test",
      deliveryNote: "",
    });
    expect(result.mode).toBe("virtual");
    expect((result as any).card).toBeUndefined();
  });
});
