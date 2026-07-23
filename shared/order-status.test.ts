import { describe, expect, it } from "vitest";
import {
  ABNORMAL_ORDER_STATUSES,
  expandOrderStatusFilter,
  isSafeDeleteOrderStatus,
  normalizeOrderStatus,
  ORDER_STATUSES,
  orderStatusLabel,
  SAFE_DELETE_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
} from "./order-status";

describe("order-status", () => {
  it("normalizes cancelled to canceled and trims case", () => {
    expect(normalizeOrderStatus("cancelled")).toBe("canceled");
    expect(normalizeOrderStatus(" Cancelled ")).toBe("canceled");
    expect(normalizeOrderStatus("CANCELED")).toBe("canceled");
    expect(normalizeOrderStatus("paid")).toBe("paid");
    expect(normalizeOrderStatus("")).toBe("");
    expect(normalizeOrderStatus(null)).toBe("");
    expect(normalizeOrderStatus(undefined)).toBe("");
  });

  it("canonical catalog never lists the legacy cancelled spelling", () => {
    expect(ORDER_STATUSES).toContain("canceled");
    expect(ORDER_STATUSES).not.toContain("cancelled");
    expect(SAFE_DELETE_ORDER_STATUSES).toEqual(["failed", "canceled", "closed", "expired"]);
    expect(SAFE_DELETE_ORDER_STATUSES).not.toContain("cancelled");
    expect(SAFE_DELETE_ORDER_STATUSES).not.toContain("refunded");
    expect(ABNORMAL_ORDER_STATUSES).toContain("refunded");
    expect(ABNORMAL_ORDER_STATUSES).toContain("canceled");
    expect(ABNORMAL_ORDER_STATUSES).not.toContain("cancelled");
    expect(TERMINAL_ORDER_STATUSES).toContain("canceled");
    expect(TERMINAL_ORDER_STATUSES).not.toContain("cancelled");
    expect(TERMINAL_ORDER_STATUSES).toContain("issued");
  });

  it("treats every safe-delete status and legacy cancelled as deletable", () => {
    for (const status of SAFE_DELETE_ORDER_STATUSES) {
      expect(isSafeDeleteOrderStatus(status)).toBe(true);
      expect(isSafeDeleteOrderStatus(status.toUpperCase())).toBe(true);
    }
    expect(isSafeDeleteOrderStatus("canceled")).toBe(true);
    expect(isSafeDeleteOrderStatus("cancelled")).toBe(true);
    expect(isSafeDeleteOrderStatus(" CANCELLED ")).toBe(true);
    expect(isSafeDeleteOrderStatus("refunded")).toBe(false);
    expect(isSafeDeleteOrderStatus("issued")).toBe(false);
    expect(isSafeDeleteOrderStatus("paid")).toBe(false);
    expect(isSafeDeleteOrderStatus("pending")).toBe(false);
    expect(isSafeDeleteOrderStatus("")).toBe(false);
    expect(isSafeDeleteOrderStatus(null)).toBe(false);
  });

  it("expands canceled filter to include legacy cancelled spelling without duplicates", () => {
    expect(expandOrderStatusFilter(["canceled", "failed"]).sort()).toEqual(
      ["canceled", "cancelled", "failed"].sort(),
    );
    expect(expandOrderStatusFilter(["cancelled"])).toEqual(["canceled", "cancelled"]);
    // 同时传入规范/历史拼写时去重，仍只展开一次
    expect(expandOrderStatusFilter(["canceled", "cancelled", "CANCELED"]).sort()).toEqual(
      ["canceled", "cancelled"].sort(),
    );
    expect(expandOrderStatusFilter(["", "  ", "failed"]).sort()).toEqual(["failed"]);
    expect(expandOrderStatusFilter([])).toEqual([]);
    // 异常 tab 全量展开应含 cancelled，便于筛到历史行
    const abnormalExpanded = expandOrderStatusFilter(ABNORMAL_ORDER_STATUSES);
    expect(abnormalExpanded).toContain("cancelled");
    expect(abnormalExpanded).toContain("canceled");
    expect(abnormalExpanded).toContain("refunded");
  });

  it("labels via normalized status", () => {
    expect(orderStatusLabel("cancelled")).toBe("已取消");
    expect(orderStatusLabel("canceled")).toBe("已取消");
    expect(orderStatusLabel("  CANCELLED ")).toBe("已取消");
    expect(orderStatusLabel("unknown-x")).toBe("unknown-x");
    expect(orderStatusLabel("")).toBe("-");
    expect(orderStatusLabel(null)).toBe("-");
  });
});
