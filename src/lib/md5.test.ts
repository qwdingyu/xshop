import { describe, expect, it } from "vitest";
import { md5Hex } from "./md5";

describe("md5Hex", () => {
  it("matches standard MD5 test vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b");
  });

  it("hashes UTF-8 input deterministically", () => {
    expect(md5Hex("商品购买-订单-支付")).toBe(md5Hex("商品购买-订单-支付"));
    expect(md5Hex("商品购买-订单-支付")).not.toBe(md5Hex("商品购买-订单-支付 "));
  });
});
