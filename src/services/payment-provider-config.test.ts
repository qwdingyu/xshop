import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { createDb } from "../db/client";
import type { DbType } from "../db/client";
import { systemConfig } from "../db/schema";
import { runMigrations } from "../db/migrations";

describe("payment provider config administration", () => {
  it("saves new payment credentials disabled until an administrator explicitly enables them", async () => {
    const encryptionKey = "a".repeat(64);
    const stored: Array<Record<string, unknown>> = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          stored.push(value);
          return {
            onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
    } as unknown as DbType;

    const { upsertPaymentProviderConfig } = await import("./admin-service");
    const { decrypt: aesDecrypt } = await import("@usethink/cf-core");
    await upsertPaymentProviderConfig(db, "easypay", {
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "secret",
      EASYPAY_API_BASE: "https://pay.example.com",
    }, encryptionKey);

    const value = String(stored[0]?.value || "");
    const decrypted = await aesDecrypt(value.slice(4), encryptionKey) as unknown as {
      enabled: boolean;
      config: Record<string, string>;
    };

    expect(value.startsWith("enc:")).toBe(true);
    expect(decrypted.enabled).toBe(false);
    expect(decrypted.config.EASYPAY_KEY).toBe("secret");
  }, 15_000);

  it("keeps an enabled payment provider enabled when its configuration is edited", async () => {
    const encryptionKey = "a".repeat(64);
    const stored: Array<Record<string, unknown>> = [];
    const { encrypt: aesEncrypt, decrypt: aesDecrypt } = await import("@usethink/cf-core");
    const currentValue = `enc:${await aesEncrypt({
      enabled: true,
      config: { EASYPAY_KEY: "old-secret" },
    }, encryptionKey)}`;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([{ value: currentValue }]) }),
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          stored.push(value);
          return {
            onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
    } as unknown as DbType;

    const { upsertPaymentProviderConfig } = await import("./admin-service");
    await upsertPaymentProviderConfig(db, "easypay", {
      EASYPAY_PID: "1001",
      EASYPAY_KEY: "updated-secret",
      EASYPAY_API_BASE: "https://pay.example.com",
    }, encryptionKey);

    const value = String(stored[0]?.value || "");
    const decrypted = await aesDecrypt(value.slice(4), encryptionKey) as unknown as {
      enabled: boolean;
      config: Record<string, string>;
    };

    expect(decrypted.enabled).toBe(true);
    expect(decrypted.config.EASYPAY_KEY).toBe("updated-secret");
  }, 15_000);

  it("keeps an edited enabled provider available to the runtime registry", async () => {
    const client = createClient({ url: "file::memory:?cache=shared" });
    const db = createDb(client);
    const encryptionKey = "c".repeat(64);
    try {
      await runMigrations(db);
      const { upsertPaymentProviderConfig, setPaymentProviderEnabled } = await import("./admin-service");
      const { createDbProviderRegistry } = await import("./payments");
      const initialConfig = {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
        EASYPAY_PAY_TYPE: "alipay",
        EASYPAY_ENABLED_PAY_TYPES: "alipay",
      };

      await expect(upsertPaymentProviderConfig(db, "easypay", initialConfig, encryptionKey)).resolves.toBe(false);
      await expect(setPaymentProviderEnabled(db, "easypay", true, encryptionKey)).resolves.toBe(true);
      await expect(upsertPaymentProviderConfig(db, "easypay", {
        ...initialConfig,
        EASYPAY_ENABLED_PAY_TYPES: "alipay,wxpay",
      }, encryptionKey)).resolves.toBe(true);

      const registry = await createDbProviderRegistry({} as never, db, encryptionKey);
      expect(registry.get("easypay")).toMatchObject({
        name: "easypay",
        defaultPayType: "alipay",
        enabledPayTypes: ["alipay", "wxpay"],
      });
    } finally {
      client.close();
    }
  }, 20_000);

  it("does not report encrypted payment credentials as enabled when the encryption key is unavailable", async () => {
    const encryptionKey = "b".repeat(64);
    const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
    const storedValue = `enc:${await aesEncrypt({
      enabled: true,
      config: {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
      },
    }, encryptionKey)}`;
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ key: "payment_provider:easypay", value: storedValue }]),
        }),
      }),
    } as unknown as DbType;

    const { getPaymentProviderConfigs } = await import("./admin-service");
    const statuses = await getPaymentProviderConfigs(db, undefined);

    expect(statuses.easypay).toEqual({
      enabled: false,
      configured: true,
      config: {},
    });
  }, 15_000);

  it("preserves encrypted credentials when toggling enabled state", async () => {
    const encryptionKey = "a".repeat(64);
    const { encrypt: aesEncrypt, decrypt: aesDecrypt } = await import("@usethink/cf-core");
    let storedValue = `enc:${await aesEncrypt({
      enabled: true,
      config: {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
      },
    }, encryptionKey)}`;

    const db = {
      select: () => ({
        from: (table?: unknown) => {
          if (table === systemConfig) {
            return {
              where: () => ({
                limit: () => Promise.resolve([{ value: storedValue }]),
                then: (resolve: (value: unknown[]) => void) => Promise.resolve([
                  { key: "payment_provider:easypay", value: storedValue },
                ]).then(resolve),
              }),
            };
          }
          return { where: () => Promise.resolve([]) };
        },
      }),
      update: () => ({
        set: (values: { value?: string }) => ({
          where: () => {
            if (values.value) storedValue = values.value;
            return Promise.resolve({ rowsAffected: 1 });
          },
        }),
      }),
    } as unknown as DbType;

    const { setPaymentProviderEnabled, getPaymentProviderConfigs } = await import("./admin-service");
    const updated = await setPaymentProviderEnabled(db, "easypay", false, encryptionKey);
    const statuses = await getPaymentProviderConfigs(db, encryptionKey);
    const decrypted = await aesDecrypt(storedValue.slice(4), encryptionKey) as unknown as {
      enabled: boolean;
      config: Record<string, string>;
    };

    expect(updated).toBe(true);
    expect(statuses.easypay).toEqual({
      enabled: false,
      configured: true,
      config: {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
      },
    });
    expect(decrypted.enabled).toBe(false);
    expect(decrypted.config.EASYPAY_KEY).toBe("secret");
  }, 15_000);

  it("ignores removed provider rows when listing admin payment config status", async () => {
    const encryptionKey = "d".repeat(64);
    const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
    const validValue = `enc:${await aesEncrypt({
      enabled: true,
      config: {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
      },
    }, encryptionKey)}`;
    const removedValue = `enc:${await aesEncrypt({
      enabled: true,
      config: { pid: "removed-zpay" },
    }, encryptionKey)}`;

    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([
            { key: "payment_provider:easypay", value: validValue },
            { key: "payment_provider:zpay", value: removedValue },
          ]),
        }),
      }),
    } as unknown as DbType;

    const { getPaymentProviderConfigs } = await import("./admin-service");
    const statuses = await getPaymentProviderConfigs(db, encryptionKey);

    expect(Object.keys(statuses)).toEqual(["easypay"]);
    expect(statuses.zpay).toBeUndefined();
  }, 15_000);

  it("writes a durable disabled tombstone when deleting a DB payment config", async () => {
    const stored: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: (value: Record<string, unknown>) => {
          stored.push(value);
          return {
            onConflictDoUpdate: () => Promise.resolve({ rowsAffected: 1 }),
          };
        },
      }),
    } as unknown as DbType;

    const { deletePaymentProviderConfig } = await import("./admin-service");
    const { PAYMENT_PROVIDER_DISABLED_VALUE } = await import("./payments");
    await deletePaymentProviderConfig(db, "easypay");

    expect(stored).toEqual([
      expect.objectContaining({
        key: "payment_provider:easypay",
        value: PAYMENT_PROVIDER_DISABLED_VALUE,
      }),
    ]);
  });
});
