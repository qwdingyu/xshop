import { describe, expect, it } from "vitest";
import {
  createEmailAccessCode,
  emailAccessSubject,
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

  it("treats Gmail +tag / dots / googlemail as the same access subject", async () => {
    expect(emailAccessSubject("u.ser+promo@gmail.com")).toBe("user@gmail.com");
    expect(emailAccessSubject("user@googlemail.com")).toBe("user@gmail.com");

    const code = await createEmailAccessCode("u.ser+promo@gmail.com", SECRET, WINDOW_START);
    await expect(verifyEmailAccessCode("user@gmail.com", code, SECRET, WINDOW_START)).resolves.toBe(true);
    await expect(verifyEmailAccessCode("user@googlemail.com", code, SECRET, WINDOW_START)).resolves.toBe(true);
    await expect(verifyEmailAccessCode("u.ser@gmail.com", code, SECRET, WINDOW_START)).resolves.toBe(true);

    // 非 Gmail 不去点，避免误把不同邮箱当成同一人
    const otherCode = await createEmailAccessCode("u.ser@example.com", SECRET, WINDOW_START);
    await expect(verifyEmailAccessCode("user@example.com", otherCode, SECRET, WINDOW_START)).resolves.toBe(false);
    // +tag 仍对所有域名归一
    const tagged = await createEmailAccessCode("user+1@example.com", SECRET, WINDOW_START);
    await expect(verifyEmailAccessCode("user@example.com", tagged, SECRET, WINDOW_START)).resolves.toBe(true);
  });

  it("refuses an unset or production default signing secret", () => {
    expect(getEmailAccessSecret(undefined, "https://shop.example.com")).toBe("");
    expect(getEmailAccessSecret("dev-only-change-me", "https://shop.example.com")).toBe("");
    expect(getEmailAccessSecret("dev-only-change-me", "http://localhost:8787")).toBe("dev-only-change-me");
    expect(getEmailAccessSecret(SECRET, "https://shop.example.com")).toBe(SECRET);
  });
});
