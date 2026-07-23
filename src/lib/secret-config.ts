const ENCRYPTED_CONFIG_PREFIX = "enc:v1:";

export function isValidSecretEncryptionKey(value: string | undefined): value is string {
  return Boolean(value && /^[a-fA-F0-9]{64}$/.test(value));
}

export async function encryptSecretConfigValue(value: string, encryptionKey: string): Promise<string> {
  if (!value) return "";
  if (!isValidSecretEncryptionKey(encryptionKey)) throw new Error("敏感配置加密密钥无效");
  const { encrypt } = await import("@usethink/cf-core");
  return `${ENCRYPTED_CONFIG_PREFIX}${await encrypt({ value }, encryptionKey)}`;
}

export async function decryptSecretConfigValue(value: string, encryptionKey?: string): Promise<string> {
  if (!value || !value.startsWith(ENCRYPTED_CONFIG_PREFIX)) return value;
  if (!isValidSecretEncryptionKey(encryptionKey)) return "";
  try {
    const { decrypt } = await import("@usethink/cf-core");
    const decrypted = await decrypt(value.slice(ENCRYPTED_CONFIG_PREFIX.length), encryptionKey) as unknown as { value?: unknown };
    return typeof decrypted?.value === "string" ? decrypted.value : "";
  } catch {
    return "";
  }
}
