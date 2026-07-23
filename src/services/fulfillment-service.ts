import type { DbType } from "../db/client";
import type { FulfillmentMode } from "../../shared/product-contract";
import {
  issueAvailableCard,
  lockCardForOrder,
  releaseLockedCardByOrder,
  releaseIssuedCard,
  rollbackIssuedCard,
  type IssuedCard,
} from "./issue-service";

export type FulfillmentDelivery = {
  accountLabel: string;
  deliverySecret: string;
  deliveryNote: string;
};

export type FulfillmentResult = {
  mode: FulfillmentMode;
  card?: IssuedCard;
  cards?: IssuedCard[];
  delivery: FulfillmentDelivery;
};

function toFulfillmentResult(card: IssuedCard): FulfillmentResult {
  return {
    mode: "card",
    card,
    delivery: {
      accountLabel: card.accountLabel,
      deliverySecret: card.deliverySecret,
      deliveryNote: card.deliveryNote,
    },
  };
}

export function toVirtualFulfillmentResult(delivery: { accountLabel: string; deliverySecret: string; deliveryNote: string }): FulfillmentResult {
  return {
    mode: "virtual",
    delivery,
  };
}

/**
 * 轻量履约窄接口。
 * 当前只有 card 一种真实适配器，因此不引入插件框架；订单、兑换和支付回调都通过这里表达履约语义。
 */
export async function fulfillCardInventory(db: DbType, orderId: string, productId: string, buyerEmail?: string, buyerContact?: string): Promise<FulfillmentResult | null> {
  const card = await issueAvailableCard(db, orderId, productId, buyerEmail, buyerContact);
  return card ? toFulfillmentResult(card) : null;
}

export async function fulfillCardInventoryItems(
  db: DbType,
  orderId: string,
  productId: string,
  quantity: number,
  buyerEmail?: string,
  buyerContact?: string,
): Promise<FulfillmentResult | null> {
  const cards: IssuedCard[] = [];
  for (let i = 0; i < quantity; i++) {
    const card = await issueAvailableCard(db, orderId, productId, buyerEmail, buyerContact);
    if (!card) {
      // 多数量发卡必须全有或全无：中途库存不足时回滚已发出的卡密，避免同一订单部分交付。
      await Promise.all(cards.map((issuedCard) => rollbackIssuedCard(db, issuedCard.id)));
      return null;
    }
    cards.push(card);
  }
  const first = cards[0];
  return {
    mode: "card",
    card: first,
    cards,
    delivery: {
      accountLabel: first.accountLabel,
      deliverySecret: first.deliverySecret,
      deliveryNote: first.deliveryNote,
    },
  };
}

export async function lockFulfillmentInventory(
  db: DbType,
  orderId: string,
  productId: string,
  lockExpiresAt: string,
): Promise<{ mode: FulfillmentMode; inventoryId: string } | null> {
  const locked = await lockCardForOrder(db, orderId, productId, lockExpiresAt);
  return locked ? { mode: "card", inventoryId: locked.id } : null;
}

export async function lockFulfillmentInventoryItems(
  db: DbType,
  orderId: string,
  productId: string,
  lockExpiresAt: string,
  quantity: number,
): Promise<{ mode: FulfillmentMode; inventoryIds: string[] } | null> {
  const inventoryIds: string[] = [];
  for (let i = 0; i < quantity; i++) {
    const locked = await lockCardForOrder(db, orderId, productId, lockExpiresAt);
    if (!locked) {
      // 下单锁库存也保持全有或全无：任何一张锁定失败，都释放当前订单已锁定的卡密。
      await releaseLockedCardByOrder(db, orderId);
      return null;
    }
    inventoryIds.push(locked.id);
  }
  return { mode: "card", inventoryIds };
}

export async function releaseFulfilledInventory(db: DbType, cardId: string, orderId: string): Promise<void> {
  await releaseIssuedCard(db, cardId, orderId);
}

export async function rollbackFulfilledInventory(db: DbType, cardId: string): Promise<void> {
  await rollbackIssuedCard(db, cardId);
}
