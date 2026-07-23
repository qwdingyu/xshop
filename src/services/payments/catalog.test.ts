import { describe, expect, it } from "vitest";
import type { DbType } from "../../db/client";
import {
  PAYMENT_PROVIDER_CATALOG,
  PAYMENT_PROVIDER_FACTORIES,
  VALID_PROVIDER_NAMES,
  getProviderMeta,
  isValidProviderName,
} from "./catalog";
import {
  createDbProviderRegistry,
  createDbProviderRegistryForCallback,
  PAYMENT_PROVIDER_DISABLED_VALUE,
  selectOnlineProviderForCurrency,
} from ".";
import type { PaymentProvider, ProviderRegistry } from ".";

describe("payment provider catalog", () => {
  it("用单一 catalog 派生运行时工厂和回调白名单", () => {
    const names = PAYMENT_PROVIDER_CATALOG.map((item) => item.name);
    expect(VALID_PROVIDER_NAMES).toEqual(names);
    expect(PAYMENT_PROVIDER_FACTORIES.map((factory) => factory.name)).toEqual(names);
  });

  it("为每个 provider 提供后台字段元数据", () => {
    for (const item of PAYMENT_PROVIDER_CATALOG) {
      expect(item.displayName).toBeTruthy();
      expect(item.description).toBeTruthy();
      expect(item.supportedCurrencies.length).toBeGreaterThan(0);
      expect(item.fields.length).toBeGreaterThan(0);
      expect(item.fields.some((field) => field.required)).toBe(true);
    }
  });

  it("支持 provider 名称查询和校验", () => {
    expect(getProviderMeta("easypay")?.description).toContain("ZPay");
    expect(isValidProviderName("zpay")).toBe(false);
    expect(isValidProviderName("stripe")).toBe(false);
    expect(isValidProviderName("usdt_trc20")).toBe(false);
    expect(isValidProviderName("unknown")).toBe(false);
  });
});

describe("database payment provider config", () => {
  it("does not select a provider when encrypted DB config is disabled", async () => {
    const encryptionKey = "b".repeat(64);
    const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
    const value = `enc:${await aesEncrypt({
      enabled: false,
      config: {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
      },
    }, encryptionKey)}`;

    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ key: "payment_provider:easypay", value }]),
        }),
      }),
    } as unknown as DbType;

    const registry = await createDbProviderRegistry({} as never, db, encryptionKey);
    expect(registry.get("easypay")).toBeFalsy();
    expect(registry.selectOnline()).toBeNull();
  }, 15_000);

  it("uses disabled-but-configured DB credentials for callback verification only", async () => {
    const encryptionKey = "b".repeat(64);
    const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
    const value = `enc:${await aesEncrypt({
      enabled: false,
      config: {
        EASYPAY_PID: "1001",
        EASYPAY_KEY: "secret",
        EASYPAY_API_BASE: "https://pay.example.com",
      },
    }, encryptionKey)}`;

    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ key: "payment_provider:easypay", value }]),
        }),
      }),
    } as unknown as DbType;

    const orderRegistry = await createDbProviderRegistry({} as never, db, encryptionKey);
    const callbackRegistry = await createDbProviderRegistryForCallback({} as never, db, encryptionKey);

    expect(orderRegistry.get("easypay")).toBeUndefined();
    expect(orderRegistry.selectOnline()).toBeNull();
    expect(callbackRegistry.get("easypay")?.name).toBe("easypay");
    expect(callbackRegistry.selectOnline()).toBeNull();
  }, 15_000);

  it("lets an explicit disabled DB config override configured environment credentials", async () => {
    const encryptionKey = "c".repeat(64);
    const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
    const value = `enc:${await aesEncrypt({
      enabled: false,
      config: {
        EASYPAY_PID: "db-1001",
        EASYPAY_KEY: "db-secret",
        EASYPAY_API_BASE: "https://db-pay.example.com",
      },
    }, encryptionKey)}`;

    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ key: "payment_provider:easypay", value }]),
        }),
      }),
    } as unknown as DbType;

    const registry = await createDbProviderRegistry({
      EASYPAY_PID: "env-1001",
      EASYPAY_KEY: "env-secret",
      EASYPAY_API_BASE: "https://env-pay.example.com",
    } as never, db, encryptionKey);

    expect(registry.get("easypay")).toBeUndefined();
    expect(registry.selectOnline()).toBeNull();
  }, 15_000);

  it("keeps an environment-configured provider disabled after its DB config is deleted", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{
            key: "payment_provider:easypay",
            value: PAYMENT_PROVIDER_DISABLED_VALUE,
          }]),
        }),
      }),
    } as unknown as DbType;

    const registry = await createDbProviderRegistry({
      EASYPAY_PID: "env-1001",
      EASYPAY_KEY: "env-secret",
      EASYPAY_API_BASE: "https://env-pay.example.com",
    } as never, db);

    expect(registry.get("easypay")).toBeUndefined();
  });

  it("does not use deleted DB payment configs for callback verification or env fallback", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{
            key: "payment_provider:easypay",
            value: PAYMENT_PROVIDER_DISABLED_VALUE,
          }]),
        }),
      }),
    } as unknown as DbType;

    const registry = await createDbProviderRegistryForCallback({
      EASYPAY_PID: "env-1001",
      EASYPAY_KEY: "env-secret",
      EASYPAY_API_BASE: "https://env-pay.example.com",
    } as never, db);

    expect(registry.get("easypay")).toBeUndefined();
  });

  it("fails closed instead of falling back to env when an encrypted DB config cannot be decrypted", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{
            key: "payment_provider:easypay",
            value: "enc:not-decryptable",
          }]),
        }),
      }),
    } as unknown as DbType;

    const registry = await createDbProviderRegistry({
      EASYPAY_PID: "env-1001",
      EASYPAY_KEY: "env-secret",
      EASYPAY_API_BASE: "https://env-pay.example.com",
    } as never, db);

    expect(registry.get("easypay")).toBeUndefined();
  });

  it("ignores removed standalone provider DB rows instead of treating them as aliases", async () => {
    const encryptionKey = "d".repeat(64);
    const { encrypt: aesEncrypt } = await import("@usethink/cf-core");
    const removedValue = `enc:${await aesEncrypt({
      enabled: true,
      config: {
        pid: "20220715225121",
        key: "removed",
        apiUrl: "https://zpayz.cn",
      },
    }, encryptionKey)}`;

    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ key: "payment_provider:zpay", value: removedValue }]),
        }),
      }),
    } as unknown as DbType;

    const registry = await createDbProviderRegistry({
      EASYPAY_PID: "env-1001",
      EASYPAY_KEY: "env-secret",
      EASYPAY_API_BASE: "https://env-pay.example.com",
    } as never, db, encryptionKey);

    expect(registry.get("zpay")).toBeUndefined();
    expect(registry.get("easypay")?.name).toBe("easypay");
  }, 15_000);
});

describe("currency-aware online provider selection", () => {
  function provider(name: string, supportedCurrencies: string[]): PaymentProvider {
    return {
      name,
      displayName: name,
      supportedCurrencies,
      createPayment: async () => ({}),
      verifyCallback: async () => ({
        orderNo: "order-1",
        providerTradeNo: "trade-1",
        amountCents: 100,
        currency: supportedCurrencies[0],
        paidAt: new Date().toISOString(),
      }),
    };
  }

  it("selects the single EasyPay provider for supported CNY orders", () => {
    const providers = new Map<string, PaymentProvider>([
      ["easypay", provider("easypay", ["CNY"])],
    ]);
    const registry: ProviderRegistry = {
      get: (name) => providers.get(name),
      list: () => [...providers.keys()],
      selectOnline: () => providers.get("easypay") || null,
    };

    expect(selectOnlineProviderForCurrency(registry, "CNY")?.name).toBe("easypay");
  });

  it("returns null when no configured provider supports the order currency", () => {
    const easypay = provider("easypay", ["CNY"]);
    const registry: ProviderRegistry = {
      get: (name) => name === "easypay" ? easypay : undefined,
      list: () => ["easypay"],
      selectOnline: () => easypay,
    };

    expect(selectOnlineProviderForCurrency(registry, "USDT")).toBeNull();
  });

  it("does not select removed providers even if a stale registry exposes them", () => {
    const trc20 = provider("usdt_trc20", ["USDT"]);
    const registry: ProviderRegistry = {
      get: (name) => name === "usdt_trc20" ? trc20 : undefined,
      list: () => ["usdt_trc20"],
      selectOnline: () => trc20,
    };

    expect(selectOnlineProviderForCurrency(registry, "USDT")).toBeNull();
  });
});
