import { describe, expect, it } from "vitest";
import {
  createEmailAccessCode,
  getEmailAccessSecret,
  verifyEmailAccessCode,
} from "./email-access";

const SECRET = "a-production-strength-admin-token";
const WINDOW_START = Date.UTC(2026, 6, 14, 0, 0, 0);

describe("email access codes", () => {
  it("creates a stable six-digit code within one time window", async () => {
    const first = await createEmailAccessCode("Buyer@Example.com", SECRET, WINDOW_START);
    const second = await createEmailAccessCode("buyer@example.com", SECRET, WINDOW_START + 60_000);

    expect(first).toMatch(/^\d{6}$/);
    expect(second).toBe(first);
  });

  it("accepts the current and immediately previous window only", async () => {
    const code = await createEmailAccessCode("buyer@example.com", SECRET, WINDOW_START);

    await expect(verifyEmailAccessCode("buyer@example.com", code, SECRET, WINDOW_START + 60_000)).resolves.toBe(true);
    await expect(verifyEmailAccessCode("buyer@example.com", code, SECRET, WINDOW_START + 6 * 60_000)).resolves.toBe(true);
    await expect(verifyEmailAccessCode("buyer@example.com", code, SECRET, WINDOW_START + 11 * 60_000)).resolves.toBe(false);
  });

  it("rejects a code for another mailbox or another secret", async () => {
    const code = await createEmailAccessCode("buyer@example.com", SECRET, WINDOW_START);

    await expect(verifyEmailAccessCode("other@example.com", code, SECRET, WINDOW_START)).resolves.toBe(false);
    await expect(verifyEmailAccessCode("buyer@example.com", code, "different-secret", WINDOW_START)).resolves.toBe(false);
  });

  it("refuses an unset or production default signing secret", () => {
    expect(getEmailAccessSecret(undefined, "https://shop.example.com")).toBe("");
    expect(getEmailAccessSecret("dev-only-change-me", "https://shop.example.com")).toBe("");
    expect(getEmailAccessSecret("dev-only-change-me", "http://localhost:8787")).toBe("dev-only-change-me");
    expect(getEmailAccessSecret(SECRET, "https://shop.example.com")).toBe(SECRET);
  });
});
