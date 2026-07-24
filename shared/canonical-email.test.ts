import { describe, expect, it } from "vitest";
import { canonicalBuyerEmail } from "./canonical-email";

describe("canonicalBuyerEmail", () => {
  it("trim 并小写", () => {
    expect(canonicalBuyerEmail("  Buyer@Example.COM ")).toBe("buyer@example.com");
  });

  it("去掉 local-part 的 +tag", () => {
    expect(canonicalBuyerEmail("user+promo@example.com")).toBe("user@example.com");
    expect(canonicalBuyerEmail("a+1@gmail.com")).toBe("a@gmail.com");
  });

  it("仅对 Gmail 去点并合并 googlemail", () => {
    expect(canonicalBuyerEmail("a.b.c@gmail.com")).toBe("abc@gmail.com");
    expect(canonicalBuyerEmail("a.b.c@googlemail.com")).toBe("abc@gmail.com");
    expect(canonicalBuyerEmail("a.b@outlook.com")).toBe("a.b@outlook.com");
  });

  it("Gmail 同时处理点号与 +tag", () => {
    expect(canonicalBuyerEmail("First.Last+tag@gmail.com")).toBe("firstlast@gmail.com");
  });

  it("连续 + 与末尾 + 只截到第一个 +", () => {
    expect(canonicalBuyerEmail("u++x@example.com")).toBe("u@example.com");
    expect(canonicalBuyerEmail("end+@gmail.com")).toBe("end@gmail.com");
  });

  it("无 @ 或缺 local 时退回 trim+lower，不抛错", () => {
    expect(canonicalBuyerEmail("not-an-email")).toBe("not-an-email");
    expect(canonicalBuyerEmail("@only-domain.com")).toBe("@only-domain.com");
    expect(canonicalBuyerEmail("")).toBe("");
  });

  it("不以 domain 部分的 + 作为 tag 边界（仅 local）", () => {
    // domain 含 + 极少见；实现以 lastIndexOf('@') 切分，local 侧去 +
    expect(canonicalBuyerEmail("user+tag@weird+host.example")).toBe("user@weird+host.example");
  });
});
