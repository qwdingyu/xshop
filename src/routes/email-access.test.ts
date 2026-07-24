import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { emailAccessRoute } from "./email-access";

const securityMocks = vi.hoisted(() => ({ verifyTurnstile: vi.fn() }));
const emailAccessMocks = vi.hoisted(() => ({ createEmailAccessCode: vi.fn() }));
const emailMocks = vi.hoisted(() => ({ sendEmail: vi.fn() }));
const rateLimitMocks = vi.hoisted(() => ({
  enforceRateLimit: vi.fn(),
  releaseCooldown: vi.fn(),
  reserveCooldown: vi.fn(),
  writeRequestLog: vi.fn(),
}));

vi.mock("../lib/security", () => ({
  verifyTurnstile: (...args: unknown[]) => securityMocks.verifyTurnstile(...args),
}));

vi.mock("../lib/email-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/email-access")>();
  return {
    ...actual,
    createEmailAccessCode: (...args: unknown[]) => emailAccessMocks.createEmailAccessCode(...args),
  };
});

vi.mock("../lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => rateLimitMocks.enforceRateLimit(...args),
  releaseCooldown: (...args: unknown[]) => rateLimitMocks.releaseCooldown(...args),
  reserveCooldown: (...args: unknown[]) => rateLimitMocks.reserveCooldown(...args),
  writeRequestLog: (...args: unknown[]) => rateLimitMocks.writeRequestLog(...args),
}));

vi.mock("../lib/runtime-config", () => ({
  readRuntimeConfig: vi.fn().mockResolvedValue({
    resendApiKey: "re_test",
    emailFrom: "shop@example.com",
    turnstileEnabled: true,
    turnstileSecretKey: "turnstile-secret",
  }),
  mergeRuntimeConfig: vi.fn((config: Record<string, unknown>) => config),
}));

vi.mock("../services/email-service", () => ({
  sendEmail: (...args: unknown[]) => emailMocks.sendEmail(...args),
}));

function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", {} as never);
    await next();
  });
  app.route("/api", emailAccessRoute);
  return app;
}

describe("POST /email/access-code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    securityMocks.verifyTurnstile.mockResolvedValue({ ok: true });
    emailAccessMocks.createEmailAccessCode.mockResolvedValue("123456");
    emailMocks.sendEmail.mockResolvedValue({ ok: true, message: "sent" });
    rateLimitMocks.enforceRateLimit.mockResolvedValue({ ok: true, ipHash: "ip-hash" });
    rateLimitMocks.reserveCooldown.mockResolvedValue({ ok: true, subjectHash: "email-hash", windowStart: 123 });
    rateLimitMocks.releaseCooldown.mockResolvedValue(undefined);
  });

  it("emails the code without returning it in the response", async () => {
    const res = await createApp().request("https://shop.example.com/api/email/access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Buyer@Example.com", turnstileToken: "token" }),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(body).not.toHaveProperty("code");
    expect(body).toHaveProperty("resendCooldownSeconds", 60);
    expect(rateLimitMocks.reserveCooldown).toHaveBeenCalledWith(
      expect.anything(),
      "email_access_code_recipient",
      "buyer@example.com",
      60,
    );
    expect(emailMocks.sendEmail).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      to: "buyer@example.com",
      template: "email_access_code",
      templateData: expect.objectContaining({ code: "123456" }),
    }));
  });

  it("cooldowns on canonical mailbox while still delivering to the typed address", async () => {
    const res = await createApp().request("https://shop.example.com/api/email/access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "U.Ser+promo@gmail.com", turnstileToken: "token" }),
    }, { ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(200);
    expect(rateLimitMocks.reserveCooldown).toHaveBeenCalledWith(
      expect.anything(),
      "email_access_code_recipient",
      "user@gmail.com",
      60,
    );
    expect(emailAccessMocks.createEmailAccessCode).toHaveBeenCalledWith(
      "u.ser+promo@gmail.com",
      "admin-secret",
    );
    expect(emailMocks.sendEmail).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      to: "u.ser+promo@gmail.com",
    }));
  });

  it("does not send when the signing secret is unsafe", async () => {
    const res = await createApp().request("https://shop.example.com/api/email/access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", turnstileToken: "token" }),
    }, { ADMIN_TOKEN: "dev-only-change-me" });

    expect(res.status).toBe(503);
    expect(emailMocks.sendEmail).not.toHaveBeenCalled();
  });

  it("blocks repeated sends to the same mailbox during cooldown", async () => {
    rateLimitMocks.reserveCooldown.mockResolvedValueOnce({
      ok: false,
      status: 429,
      message: "验证码发送过于频繁，请 60 秒后再试",
      retryAfterSeconds: 60,
      subjectHash: "email-hash",
    });

    const res = await createApp().request("https://shop.example.com/api/email/access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", turnstileToken: "token" }),
    }, { ADMIN_TOKEN: "admin-secret" });
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(429);
    expect(body.error).toBe("验证码发送过于频繁，请 60 秒后再试");
    expect(body.details).toEqual(expect.objectContaining({
      code: "EMAIL_CODE_COOLDOWN",
      retryAfterSeconds: 60,
    }));
    expect(emailMocks.sendEmail).not.toHaveBeenCalled();
  });

  it("releases the recipient cooldown when the email provider fails", async () => {
    emailMocks.sendEmail.mockResolvedValueOnce({ ok: false, message: "provider failed" });

    const res = await createApp().request("https://shop.example.com/api/email/access-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "buyer@example.com", turnstileToken: "token" }),
    }, { ADMIN_TOKEN: "admin-secret" });

    expect(res.status).toBe(502);
    expect(rateLimitMocks.releaseCooldown).toHaveBeenCalledWith(
      expect.anything(),
      "email_access_code_recipient",
      expect.objectContaining({ ok: true, subjectHash: "email-hash", windowStart: 123 }),
    );
  });
});
