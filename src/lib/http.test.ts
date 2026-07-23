import { describe, it, expect } from "vitest";
import { normalizeCode, maskContact, ok, fail } from "./http";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";

describe("normalizeCode", () => {
  it("trims whitespace", () => {
    expect(normalizeCode("  ABC123  ")).toBe("abc123");
  });
  it("converts to lowercase", () => {
    expect(normalizeCode("ABCxyz")).toBe("abcxyz");
  });
  it("handles undefined", () => {
    expect(normalizeCode(undefined)).toBe("");
  });
  it("handles null", () => {
    expect(normalizeCode(null as unknown as string)).toBe("");
  });
  it("handles mixed case and spaces", () => {
    expect(normalizeCode("  NewUser10  ")).toBe("newuser10");
  });
});

describe("maskContact", () => {
  it("masks email", () => {
    expect(maskContact("user@gmail.com")).toBe("us***@gmail.com");
  });
  it("masks short email", () => {
    expect(maskContact("a@x.cn")).toBe("a***@x.cn");
  });
  it("masks phone-like string", () => {
    expect(maskContact("13812345678")).toBe("13***78");
  });
  it("masks short phone", () => {
    expect(maskContact("1234")).toBe("***");
  });
  it("handles empty string", () => {
    expect(maskContact("  ")).toBe("***");
  });
  it("passes through short strings unchanged", () => {
    expect(maskContact("ab")).toBe("***");
  });
  it("handles email with long name", () => {
    expect(maskContact("longusername@domain.co.uk")).toBe("lo***@domain.co.uk");
  });
  it("handles @-starting string (not email)", () => {
    expect(maskContact("@wechat_id")).toBe("@w***id");
  });
});

// ---------------------------------------------------------------------------
// Test ok/fail via a real Hono app (integration approach for simple response helpers)
// ---------------------------------------------------------------------------

describe("ok/fail response helpers", () => {
  it("ok returns { ok: true, ...data } with status 200", async () => {
    const app = new Hono<AppEnv>();
    app.get("/test-ok", (c) => ok(c, { message: "success" }));
    const res = await app.request("/test-ok");
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toBe("success");
  });

  it("fail returns { ok: false, error: msg } with given status", async () => {
    const app = new Hono<AppEnv>();
    app.get("/test-fail", (c) => fail(c, "something went wrong", 400));
    const res = await app.request("/test-fail");
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("something went wrong");
  });

  it("fail includes details when provided", async () => {
    const app = new Hono<AppEnv>();
    app.get("/test-fail-details", (c) => fail(c, "validation error", 422, { field: "email" }));
    const res = await app.request("/test-fail-details");
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(422);
    expect(body.details).toEqual({ field: "email" });
  });

  it("fail defaults to status 400", async () => {
    const app = new Hono<AppEnv>();
    app.get("/test-default", (c) => fail(c, "default error"));
    const res = await app.request("/test-default");
    expect(res.status).toBe(400);
  });

  it("ok with custom status", async () => {
    const app = new Hono<AppEnv>();
    app.get("/test-created", (c) => ok(c, { id: "new-1" }, 201));
    const res = await app.request("/test-created");
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.id).toBe("new-1");
  });
});