import { describe, expect, it } from "vitest";
import {
  decryptSecretConfigValue,
  encryptSecretConfigValue,
  isValidSecretEncryptionKey,
} from "./secret-config";

describe("secret system config encryption", () => {
  it("encrypts and decrypts a sensitive value without retaining plaintext", async () => {
    const key = "a".repeat(64);
    const encrypted = await encryptSecretConfigValue("private-api-key", key);

    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain("private-api-key");
    await expect(decryptSecretConfigValue(encrypted, key)).resolves.toBe("private-api-key");
  });

  it("fails closed when an encrypted value cannot be decrypted", async () => {
    await expect(decryptSecretConfigValue("enc:v1:invalid", "bad-key")).resolves.toBe("");
  });

  it("accepts only 64-character hexadecimal keys", () => {
    expect(isValidSecretEncryptionKey("a".repeat(64))).toBe(true);
    expect(isValidSecretEncryptionKey("z".repeat(64))).toBe(false);
  });
});
