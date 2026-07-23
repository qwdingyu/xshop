import { describe, it, expect } from "vitest";
import { createOrderToken, hashOrderToken, createOrderNo } from "./token";

describe("createOrderToken", () => {
  it("returns a non-empty string", () => {
    const token = createOrderToken();
    expect(token).toBeTruthy();
    expect(typeof token).toBe("string");
  });

  it("returns unique tokens on each call", () => {
    const token1 = createOrderToken();
    const token2 = createOrderToken();
    expect(token1).not.toBe(token2);
  });

  it("returns URL-safe characters only (no + / =)", () => {
    const token = createOrderToken();
    expect(token).not.toMatch(/[+/=]/);
  });
});

describe("hashOrderToken", () => {
  it("returns a hex string", async () => {
    const token = createOrderToken();
    const hash = await hashOrderToken(token);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns consistent hash for same token", async () => {
    const token = createOrderToken();
    const hash1 = await hashOrderToken(token);
    const hash2 = await hashOrderToken(token);
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different tokens", async () => {
    const token1 = createOrderToken();
    const token2 = createOrderToken();
    const hash1 = await hashOrderToken(token1);
    const hash2 = await hashOrderToken(token2);
    expect(hash1).not.toBe(hash2);
  });

  it("hash is 64 characters (SHA-256)", async () => {
    const token = createOrderToken();
    const hash = await hashOrderToken(token);
    expect(hash.length).toBe(64);
  });
});

describe("createOrderNo", () => {
  it("returns a string starting with AB", () => {
    const orderNo = createOrderNo();
    expect(orderNo.startsWith("AB")).toBe(true);
  });

  it("includes date stamp in YYYYMMDD format", () => {
    const orderNo = createOrderNo();
    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10).replaceAll("-", "");
    expect(orderNo).toContain(dateStamp);
  });

  it("returns unique order numbers on each call", () => {
    const no1 = createOrderNo();
    const no2 = createOrderNo();
    expect(no1).not.toBe(no2);
  });

  it("has correct length (AB + 8 date digits + 8 random = 18)", () => {
    const orderNo = createOrderNo();
    expect(orderNo.length).toBe(18);
  });
});
