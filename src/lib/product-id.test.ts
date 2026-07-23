import { describe, expect, it } from "vitest";
import { optionalProductIdSchema, productIdSchema } from "./product-id";

describe("productIdSchema", () => {
  it("accepts ASCII ids and legacy unicode ids", () => {
    expect(productIdSchema.parse("prod-1")).toBe("prod-1");
    expect(productIdSchema.parse("useai兑换码-用户福利")).toBe("useai兑换码-用户福利");
    expect(optionalProductIdSchema.parse("")).toBe("");
  });

  it("rejects names or unsafe URL fragments instead of accepting ambiguous product ids", () => {
    for (const value of ["useai 兑换码", "useai/兑换码", "useai?兑换码", "a", "x".repeat(81)]) {
      const result = productIdSchema.safeParse(value);
      expect(result.success, value).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("商品 ID 必须是 2-80 位");
      }
    }
  });
});
