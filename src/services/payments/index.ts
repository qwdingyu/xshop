/**
 * 支付渠道适配层 — cf-shop → @usethink/cf-core/features/payment
 *
 * 此文件是薄适配器，将所有支付能力从 cf-core 重新导出，
 * 并提供 cf-shop 专用的 createProviderRegistry(env: Bindings) 签名。
 *
 * 支持两种配置来源：
 * 1. 环境变量（传统模式，优先级低）
 * 2. 数据库加密配置（Web 管理后台模式，优先级高）
 *
 * 通用 Provider 由 cf-core 提供；cf-shop 只保留和本项目运营模型强相关的
 * 易支付兼容适配器与 DB 加密配置装配逻辑。
 */

// ═══════════════════════════════════════════════════════════════
// 从 cf-core 重新导出类型
// ═══════════════════════════════════════════════════════════════

export type {
  PaymentProvider,
  CreatePaymentInput,
  CreatePaymentResult,
  CallbackResult,
  QueryStatusResult,
  RefundInput,
  RefundResult,
  ProviderRegistry,
  ProviderFactory,
} from "@usethink/cf-core/features/payment";

export type { DbProviderConfig, DbProviderConfigMap } from "@usethink/cf-core/features/payment";

// ── 本地 Provider 导出（测试 / 调试用）──
export {
  EasyPayProviderError,
  EasyPayProvider,
  isAmbiguousEasyPayProviderError,
  normalizeEasyPayApiBaseUrl,
  buildEasyPayPaymentApiUrl,
  buildEasyPayQueryApiUrl,
  easyPayPayTypeLabel,
  normalizeEasyPayPayType,
  normalizeEasyPayEnabledPayTypes,
} from "./easypay";

// ═══════════════════════════════════════════════════════════════
// 注册表工厂 + DB 支付配置加载
// ═══════════════════════════════════════════════════════════════

import {
  createProviderRegistry as createCoreRegistry,
  selectPaymentProviderForCurrency,
} from "@usethink/cf-core/features/payment";
import type { Bindings } from "../../bindings";
import type { DbType } from "../../db/client";
import type { PaymentProvider, ProviderRegistry, DbProviderConfigMap } from "@usethink/cf-core/features/payment";
export { PAYMENT_PROVIDER_CATALOG, PAYMENT_PROVIDER_FACTORIES, VALID_PROVIDER_NAMES, isValidProviderName, getProviderMeta } from "./catalog";
export type { PaymentProviderCatalogItem, ProviderFieldMeta, ValidProviderName } from "./catalog";
import { PAYMENT_PROVIDER_CATALOG, PAYMENT_PROVIDER_FACTORIES, isValidProviderName } from "./catalog";

export const PAYMENT_PROVIDER_DISABLED_VALUE = "disabled:v1";

export function selectOnlineProviderForCurrency(
  registry: ProviderRegistry,
  currency: string,
): PaymentProvider | null {
  const providersByPriority = [...PAYMENT_PROVIDER_CATALOG]
    .sort((left, right) => left.factory.priority - right.factory.priority);
  return selectPaymentProviderForCurrency(
    providersByPriority.map((item) => registry.get(item.name)),
    currency,
  );
}

/**
 * 从 systemConfig 读取并解密所有支付配置。
 *
 * 查询前缀 `payment_provider:` 的所有配置项，逐一解密，
 * 返回 providerName → DbProviderConfig 的映射。
 *
 * @param db - Drizzle ORM 实例
 * @param encryptionKey - CREDENTIALS_ENCRYPTION_KEY（64 字符 hex）
 * @returns 解密后的支付配置映射，未配置或解密失败时返回空对象
 */
export async function loadPaymentProviderConfigs(
  db: DbType,
  encryptionKey?: string,
): Promise<DbProviderConfigMap> {
  const { systemConfig } = await import("../../db/schema");
  const { sql } = await import("drizzle-orm");

  const prefix = "payment_provider:";
  const rows = await db
    .select({ key: systemConfig.key, value: systemConfig.value })
    .from(systemConfig)
    .where(sql`${systemConfig.key} LIKE ${prefix + "%"}`);

  const result: DbProviderConfigMap = {};
  const validEncryptionKey = Boolean(encryptionKey && /^[a-fA-F0-9]{64}$/.test(encryptionKey));

  for (const row of rows) {
    const providerName = row.key.slice(prefix.length);
    // 运行时只承认当前支付目录里的 provider。旧 DB 行不会被迁移成兼容别名，
    // 因为服务商品牌不再等同于独立支付通道。
    if (!isValidProviderName(providerName)) continue;
    if (row.value === PAYMENT_PROVIDER_DISABLED_VALUE) {
      // 删除配置写入禁用墓碑；即使环境变量里还残留同名凭据，也必须保持后台“已禁用”的语义。
      result[providerName] = { enabled: false, config: {} };
      continue;
    }
    if (!row.value?.startsWith("enc:") || !validEncryptionKey) {
      // 数据库记录代表显式管理意图；无法解密时必须覆盖环境变量并 fail closed。
      result[providerName] = { enabled: false, config: {} };
      continue;
    }

    const encryptedBase64 = row.value.slice(4); // 去掉 "enc:" 前缀

    try {
      const { decrypt: aesDecrypt } = await import("@usethink/cf-core");
      const decrypted = await aesDecrypt(encryptedBase64, encryptionKey!);
      const payload = decrypted as unknown as { enabled?: boolean; config?: Record<string, unknown> };
      result[providerName] = {
        // enabled 必须显式为 true 才注册。缺省/异常 payload 不自动启用，避免半写入配置开始收款。
        enabled: !!payload?.enabled,
        config: payload?.config || {},
      };
    } catch (err) {
      console.warn(`[payments] 解密支付配置失败: ${row.key}`, err);
      result[providerName] = { enabled: false, config: {} };
    }
  }

  return result;
}

/**
 * 创建 per-request 的 Provider 注册表（纯环境变量模式）。
 *
 * 根据 Bindings 中配置的凭证自动实例化已配置的当前渠道。
 *
 * @example
 * ```ts
 * const registry = createProviderRegistry(c.env);
 * const provider = registry.selectOnline();
 * ```
 */
export function createProviderRegistry(env: Bindings): ProviderRegistry {
  return createCoreRegistry(env as Record<string, unknown>, PAYMENT_PROVIDER_FACTORIES);
}

/**
 * 创建 per-request 的 Provider 注册表（混合模式）。
 *
 * 数据库加密配置优先于环境变量。适用于 Web 管理后台配置的场景。
 *
 * @example
 * ```ts
 * const registry = await createDbProviderRegistry(c.env, db, c.env.CREDENTIALS_ENCRYPTION_KEY);
 * const provider = registry.selectOnline();
 * ```
 */
export async function createDbProviderRegistry(
  env: Bindings,
  db: DbType,
  encryptionKey?: string,
): Promise<ProviderRegistry> {
  const dbConfigs = await loadPaymentProviderConfigs(db, encryptionKey);
  const effectiveEnv: Record<string, unknown> = { ...env };

  // 后台显式禁用必须覆盖环境变量，否则 UI 显示“已禁用”但运行时仍会继续收款。
  for (const [providerName, config] of Object.entries(dbConfigs)) {
    if (config.enabled) continue;
    const catalogItem = PAYMENT_PROVIDER_CATALOG.find((item) => item.name === providerName);
    // DB 禁用状态覆盖环境变量时，只删除 catalog 声明过的字段，避免误删其他系统配置。
    for (const field of catalogItem?.fields || []) {
      delete effectiveEnv[field.key];
    }
  }

  return createCoreRegistry(effectiveEnv, PAYMENT_PROVIDER_FACTORIES, dbConfigs);
}

/**
 * 创建支付回调用 Provider 注册表。
 *
 * 与新下单选择不同，支付回调必须优先完成“验签 + 金额校验 + 订单状态收敛”。
 * 管理员禁用渠道只代表停止创建新订单，不能让已经创建的 pending/expired 订单失去验签密钥。
 * 因此这里允许读取“已配置但 enabled=false”的加密凭据来处理既有回调；删除墓碑或解密失败仍然 fail closed，
 * 且会覆盖环境变量，避免 UI 显示已删除但运行时继续使用旧 env 密钥。
 */
export async function createDbProviderRegistryForCallback(
  env: Bindings,
  db: DbType,
  encryptionKey?: string,
): Promise<ProviderRegistry> {
  const dbConfigs = await loadPaymentProviderConfigs(db, encryptionKey);
  const effectiveEnv: Record<string, unknown> = { ...env };
  const callbackConfigs: DbProviderConfigMap = {};

  for (const [providerName, config] of Object.entries(dbConfigs)) {
    const catalogItem = PAYMENT_PROVIDER_CATALOG.find((item) => item.name === providerName);
    for (const field of catalogItem?.fields || []) {
      delete effectiveEnv[field.key];
    }

    const hasStoredCredentials = Object.keys(config.config || {}).length > 0;
    callbackConfigs[providerName] = hasStoredCredentials
      ? { enabled: true, config: config.config }
      : { enabled: false, config: {} };
  }

  const registry = createCoreRegistry(effectiveEnv, PAYMENT_PROVIDER_FACTORIES, callbackConfigs);
  return {
    get: (name) => registry.get(name),
    list: () => registry.list(),
    // 回调注册表只服务于“按回调路径中的 provider 名称验签”，故意不提供线上选择能力。
    selectOnline: () => null,
  };
}
