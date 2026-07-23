import { describe, expect, it } from "vitest";
import {
  DEFAULT_OFFLINE_PAY_HINT,
  normalizeOfflinePayHintForSmoke,
} from "./smoke-system-config.mjs";

describe("normalizeOfflinePayHintForSmoke", () => {
  it.each([
    "true",
    "false legacy value",
    "线下付款 smoke 提示 1784443684790",
  ])("repairs known non-merchant hint value %s", (value) => {
    expect(normalizeOfflinePayHintForSmoke(value)).toBe(DEFAULT_OFFLINE_PAY_HINT);
  });

  it("preserves merchant-authored text exactly", () => {
    const value = "付款后请填写支付宝交易号后 4 位";
    expect(normalizeOfflinePayHintForSmoke(value)).toBe(value);
  });
});
