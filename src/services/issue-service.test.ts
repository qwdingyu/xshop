import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbType } from "../db/client";
import { issueAvailableCard, lockCardForOrder, releaseLockedCardByOrder, releaseIssuedCard } from "./issue-service";

// ---------------------------------------------------------------------------
// Mock Database that tracks card state via Drizzle ORM chains
// ---------------------------------------------------------------------------
// issue-service now uses Drizzle ORM for releaseLockedCardByOrder and releaseIssuedCard.
// issueAvailableCard and lockCardForOrder still use db.run(sql`...`) for atomic operations.
//
// We need to mock:
//   1. db.run(sql`UPDATE cards SET status='issued'...RETURNING...`) → for issueAvailableCard
//   2. db.run(sql`UPDATE cards SET status='locked'...RETURNING...`) → for lockCardForOrder
//   3. db.select({id: cards.id}).from(cards).where(...) → for releaseLockedCardByOrder (find locked cards)
//   4. db.update(cards).set({...}).where(...) → for releaseLockedCardByOrder (release locks)
//   5. db.update(cards).set({...}).where(...) → for releaseIssuedCard
//   6. db.insert(cardLogs).values({...}) → for writeCardLog (wrapped in catch)

// Helper: extract SQL text from Drizzle SQL template object
function extractSqlText(sqlExpr: any): string {
  if (!sqlExpr) return "";
  if (typeof sqlExpr === "string") return sqlExpr;
  const sqlObj = sqlExpr.getSQL?.() ?? sqlExpr;
  if (typeof sqlObj === "string") return sqlObj;
  if (sqlObj?.queryChunks && Array.isArray(sqlObj.queryChunks)) {
    let text = "";
    for (const chunk of sqlObj.queryChunks) {
      if (typeof chunk === "string") text += chunk;
      else if (chunk?.value && Array.isArray(chunk.value)) text += chunk.value.join("");
      else if (typeof chunk?.value === "string") text += chunk.value;
      else text += "?";
    }
    return text;
  }
  try { return String(sqlObj); } catch { return ""; }
}

// Operation log for debugging
const ops: Array<{ type: string; sql?: string; data?: unknown }> = [];

// Current order context for filtering — set by tests
let currentOrderId: string | null = null;
let currentProductId: string | null = null;

function createMockDb(state: {
  cards?: Record<string, Record<string, unknown>>;
  logs?: Array<{ cardId: string; action: string }>;
} = {}): DbType {
  const logs = state.logs || [];
  const cardMap = state.cards || {};
  let selectCall = 0;

  return {
    // db.run(sql`...`) — intercepts raw SQL for atomic card operations
    run: (sqlExpr: any) => {
      const q = extractSqlText(sqlExpr).toLowerCase();
      ops.push({ type: "run", sql: q });

      // 释放过期 locked 卡密：UPDATE cards SET status='available' ... WHERE status='locked' AND lock_expires_at < ...
      // 必须区分：
      //   - 释放 SQL: SET status = 'available'（主句）
      //   - 锁定 SQL: SET status = 'locked'（主句，子查询包含 status = 'available'）
      //   - 发卡 SQL: SET status = 'issued'（主句，子查询包含 status = 'available' 和 lock_expires_at = NULL）
      // 精确匹配 "set status = 'available'" 出现在主句中（紧跟在 UPDATE cards SET 之后）
      if (q.includes("update cards") && q.includes("set status = 'available'") && q.includes("lock_expires_at")) {
        // 释放该商品下所有过期 locked 卡密
        for (const [cardId, card] of Object.entries(cardMap)) {
          if (
            card.status === "locked" &&
            (!currentProductId || card.productId === currentProductId) &&
            card.lockExpiresAt &&
            new Date(card.lockExpiresAt as string) < new Date()
          ) {
            cardMap[cardId].status = "available";
            cardMap[cardId].lockedOrderId = null;
            cardMap[cardId].lockExpiresAt = null;
          }
        }
        return Promise.resolve({ rows: [] });
      }

      // issueAvailableCard: UPDATE cards SET status='issued' ... RETURNING
      if (q.includes("update cards") && q.includes("issued")) {
        // First try to find a locked card for this order
        for (const [cardId, card] of Object.entries(cardMap)) {
          if (card.lockedOrderId === currentOrderId && card.status === "locked") {
            if (cardMap[cardId]) cardMap[cardId].status = "issued";
            return Promise.resolve({
              rows: [{
                id: cardId,
                accountLabel: card.accountLabel,
                deliverySecret: card.deliverySecret,
                deliveryNote: card.deliveryNote,
              }],
            });
          }
        }
        // Then check for available cards (only if no locked card for this order exists)
        const hasLocked = Object.values(cardMap).some(
          c => c.lockedOrderId === currentOrderId && c.status === "locked"
        );
        if (!hasLocked) {
          for (const [cardId, card] of Object.entries(cardMap)) {
            if (card.status === "available" && (!currentProductId || card.productId === currentProductId)) {
              if (cardMap[cardId]) cardMap[cardId].status = "issued";
              return Promise.resolve({
                rows: [{
                  id: cardId,
                  accountLabel: card.accountLabel,
                  deliverySecret: card.deliverySecret,
                  deliveryNote: card.deliveryNote,
                }],
              });
            }
          }
        }
        return Promise.resolve({ rows: [] });
      }

      // lockCardForOrder: UPDATE cards SET status='locked' ... RETURNING
      if (q.includes("update cards") && q.includes("locked")) {
        for (const [cardId, card] of Object.entries(cardMap)) {
          if (card.status === "available" && (!currentProductId || card.productId === currentProductId)) {
            if (cardMap[cardId]) {
              cardMap[cardId].status = "locked";
              cardMap[cardId].lockedOrderId = currentOrderId || "";
            }
            return Promise.resolve({
              rows: [{ id: cardId }],
            });
          }
        }
        return Promise.resolve({ rows: [] });
      }

      // card_logs INSERT (from writeCardLog — uses db.insert now, not db.run)
      return Promise.resolve({ rows: [] });
    },

    // db.select({...}).from(cards).where(...)
    select: (_cols?: unknown) => ({
      from: (_table?: unknown) => ({
        where: (_cond?: unknown) => {
          selectCall += 1;
          const expectedStatus = selectCall === 1 ? "locked" : "issued";
          const expectedOrderKey = expectedStatus === "locked" ? "lockedOrderId" : "issuedOrderId";
          const matchingCards = Object.entries(cardMap)
            .filter(([, c]) => c.status === expectedStatus && c[expectedOrderKey] === currentOrderId)
            .map(([id]) => ({ id }));
          return Promise.resolve(matchingCards);
        },
      }),
    }),

    // db.update(cards).set({...}).where(...)
    update: (_table?: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: (_cond?: unknown) => {
          ops.push({ type: "update", data });
          // releaseLockedCardByOrder: set status='available', lockedOrderId=null, lockExpiresAt=null
          if ("status" in data && data.status === "available" && !("issuedOrderId" in data)) {
            for (const [cardId, card] of Object.entries(cardMap)) {
              if (card.status === "locked" && card.lockedOrderId === currentOrderId) {
                cardMap[cardId].status = "available";
                cardMap[cardId].lockedOrderId = null;
                cardMap[cardId].lockExpiresAt = null;
              }
            }
          }
          // releaseIssuedCard: set status='available', issuedOrderId=null, issuedAt=null
          if ("status" in data && data.status === "available" && "issuedOrderId" in data && data.issuedOrderId === null) {
            for (const [cardId, card] of Object.entries(cardMap)) {
              if (card.status === "issued" && card.issuedOrderId === currentOrderId) {
                cardMap[cardId].status = "available";
                cardMap[cardId].issuedOrderId = null;
                cardMap[cardId].issuedAt = null;
              }
            }
          }
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
    }),

    // db.insert(cardLogs).values({...}) — for writeCardLog
    insert: (_table?: unknown) => ({
      values: (data: Record<string, unknown>) => {
        logs.push({ cardId: String(data.cardId || ""), action: String(data.action || "") });
        return {
          catch: () => Promise.resolve(),
          then: (resolve: () => void) => Promise.resolve().then(resolve),
        };
      },
    }),

    delete: (_table?: unknown) => ({
      where: (_cond?: unknown) => Promise.resolve({ rowsAffected: 0 }),
    }),
  } as unknown as DbType;
}

// ---------------------------------------------------------------------------
// issueAvailableCard tests
// ---------------------------------------------------------------------------

describe("issueAvailableCard", () => {
  beforeEach(() => {
    ops.length = 0;
    currentOrderId = null;
    currentProductId = null;
  });

  it("returns null when no available card", async () => {
    currentOrderId = "order-1";
    const db = createMockDb({ cards: {} });
    const result = await issueAvailableCard(db, "order-1", "product-1");
    expect(result).toBeFalsy();
  });

  it("returns issued card when available card exists", async () => {
    currentOrderId = "order-1";
    const db = createMockDb({
      cards: {
        "card-1": {
          id: "card-1",
          productId: "product-1",
          status: "available",
          accountLabel: "ACC-001",
          deliverySecret: "SECRET-001",
          deliveryNote: "Note 1",
        },
      },
    });
    const result = await issueAvailableCard(db, "order-1", "product-1");
    expect(result).toBeTruthy();
    expect(result!.id).toBe("card-1");
    expect(result!.accountLabel).toBe("ACC-001");
    expect(result!.deliverySecret).toBe("SECRET-001");
  });

  it("prefers locked card for the same order over available card", async () => {
    currentOrderId = "order-1";
    currentProductId = "product-1";
    const db = createMockDb({
      cards: {
        "card-locked": {
          id: "card-locked",
          productId: "product-1",
          status: "locked",
          lockedOrderId: "order-1",
          accountLabel: "ACC-LOCKED",
          deliverySecret: "SECRET-LOCKED",
          deliveryNote: "Locked note",
        },
        "card-available": {
          id: "card-available",
          productId: "product-1",
          status: "available",
          accountLabel: "ACC-AVAIL",
          deliverySecret: "SECRET-AVAIL",
          deliveryNote: "Available note",
        },
      },
    });
    const result = await issueAvailableCard(db, "order-1", "product-1");
    expect(result).toBeTruthy();
    expect(result!.id).toBe("card-locked");
    expect(result!.accountLabel).toBe("ACC-LOCKED");
  });

  it("does not issue a card locked by another order", async () => {
    currentOrderId = "order-1";
    currentProductId = "product-1";
    const state = {
      cards: {
        "card-other-lock": {
          id: "card-other-lock",
          productId: "product-1",
          status: "locked",
          lockedOrderId: "order-2",
          accountLabel: "ACC-OTHER",
          deliverySecret: "SECRET-OTHER",
          deliveryNote: "Other order lock",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    const result = await issueAvailableCard(db, "order-1", "product-1");
    expect(result).toBeFalsy();
    expect(state.cards["card-other-lock"].status).toBe("locked");
    expect(state.cards["card-other-lock"].lockedOrderId).toBe("order-2");
  });

  it("does not issue an available card from another product", async () => {
    currentOrderId = "order-1";
    currentProductId = "product-1";
    const state = {
      cards: {
        "card-other-product": {
          id: "card-other-product",
          productId: "product-2",
          status: "available",
          accountLabel: "ACC-OTHER-PRODUCT",
          deliverySecret: "SECRET-OTHER-PRODUCT",
          deliveryNote: "Other product",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    const result = await issueAvailableCard(db, "order-1", "product-1");
    expect(result).toBeFalsy();
    expect(state.cards["card-other-product"].status).toBe("available");
  });

  it("updates card status to issued", async () => {
    currentOrderId = "order-1";
    const state = {
      cards: {
        "card-1": {
          id: "card-1",
          productId: "product-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    await issueAvailableCard(db, "order-1", "product-1");
    expect(state.cards["card-1"].status).toBe("issued");
  });
});

// ---------------------------------------------------------------------------
// lockCardForOrder tests
// ---------------------------------------------------------------------------

describe("lockCardForOrder", () => {
  beforeEach(() => {
    ops.length = 0;
    currentOrderId = null;
    currentProductId = null;
  });

  it("returns null when no available card to lock", async () => {
    currentOrderId = "order-1";
    const db = createMockDb({ cards: {} });
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = await lockCardForOrder(db, "order-1", "product-1", expiresAt);
    expect(result).toBeFalsy();
  });

  it("locks available card and returns its id", async () => {
    currentOrderId = "order-1";
    const state = {
      cards: {
        "card-1": {
          id: "card-1",
          productId: "product-1",
          status: "available",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
          lockedOrderId: null,
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = await lockCardForOrder(db, "order-1", "product-1", expiresAt);
    expect(result).toBeTruthy();
    expect(result!.id).toBe("card-1");
    expect(state.cards["card-1"].status).toBe("locked");
    expect(state.cards["card-1"].lockedOrderId).toBe("order-1");
  });

  it("does not lock already locked card", async () => {
    currentOrderId = "order-1";
    const db = createMockDb({
      cards: {
        "card-locked": {
          id: "card-locked",
          productId: "product-1",
          status: "locked",
          lockedOrderId: "other-order",
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
        },
      },
    });
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = await lockCardForOrder(db, "order-1", "product-1", expiresAt);
    expect(result).toBeFalsy();
  });

  it("does not lock an available card from another product", async () => {
    currentOrderId = "order-1";
    currentProductId = "product-1";
    const state = {
      cards: {
        "card-other-product": {
          id: "card-other-product",
          productId: "product-2",
          status: "available",
          lockedOrderId: null,
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = await lockCardForOrder(db, "order-1", "product-1", expiresAt);
    expect(result).toBeFalsy();
    expect(state.cards["card-other-product"].status).toBe("available");
    expect(state.cards["card-other-product"].lockedOrderId).toBeNull();
  });

  it("releases expired locked cards before locking available card", async () => {
    currentOrderId = "order-1";
    const pastTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago (expired)
    const state = {
      cards: {
        "card-expired-lock": {
          id: "card-expired-lock",
          productId: "product-1",
          status: "locked",
          lockedOrderId: "old-order",
          lockExpiresAt: pastTime,
          accountLabel: "ACC-EX",
          deliverySecret: "SEC-EX",
          deliveryNote: "",
        },
        "card-available": {
          id: "card-available",
          productId: "product-1",
          status: "available",
          lockedOrderId: null,
          accountLabel: "ACC-AV",
          deliverySecret: "SEC-AV",
          deliveryNote: "",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const result = await lockCardForOrder(db, "order-1", "product-1", expiresAt);
    // 过期 locked 卡密应被释放回 available，然后锁定一张 available 卡密
    // mock 按 Object.entries 顺序查找，card-expired-lock 先被释放为 available，再被锁定
    expect(result).toBeTruthy();
    expect(result!.id).toBe("card-expired-lock");
    expect(state.cards["card-expired-lock"].status).toBe("locked");
    expect(state.cards["card-available"].status).toBe("available");

    const releaseSql = ops.find((op) => op.sql?.includes("set status = 'available'"))?.sql || "";
    expect(releaseSql).toContain("not exists");
    expect(releaseSql).toContain("'pending'");
    expect(releaseSql).toContain("'paid'");
    expect(releaseSql).toContain("'issued'");
  });
});

// ---------------------------------------------------------------------------
// releaseLockedCardByOrder tests
// ---------------------------------------------------------------------------

describe("releaseLockedCardByOrder", () => {
  beforeEach(() => {
    ops.length = 0;
    currentOrderId = null;
    currentProductId = null;
  });

  it("releases locked cards for the given order", async () => {
    currentOrderId = "order-1";
    const state = {
      cards: {
        "card-1": {
          id: "card-1",
          productId: "product-1",
          status: "locked",
          lockedOrderId: "order-1",
          accountLabel: "ACC",
     deliverySecret: "SEC",
          deliveryNote: "",
          lockExpiresAt: "2026-01-01T00:00:00Z",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    await releaseLockedCardByOrder(db, "order-1");
    expect(state.cards["card-1"].status).toBe("available");
    expect(state.cards["card-1"].lockedOrderId).toBeNull();
    expect(state.cards["card-1"].lockExpiresAt).toBeNull();
  });

  it("does not release cards locked by other orders", async () => {
    currentOrderId = "order-1"; // We're releasing for order-1
    const state = {
      cards: {
        "card-other": {
          id: "card-other",
          productId: "product-1",
          status: "locked",
          lockedOrderId: "order-2", // This belongs to order-2
          accountLabel: "ACC",
          deliverySecret: "SEC",
          deliveryNote: "",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    await releaseLockedCardByOrder(db, "order-1");
    expect(state.cards["card-other"].status).toBe("locked");
  });

  it("handles no locked cards gracefully", async () => {
    currentOrderId = "order-1";
    const db = createMockDb({ cards: {} });
    await expect(releaseLockedCardByOrder(db, "order-1")).resolves.toBe(0);
  });

  it("releases issued compensation leftovers only for the given order", async () => {
    currentOrderId = "order-1";
    const state = {
      cards: {
        "card-issued-this-order": {
          id: "card-issued-this-order",
          status: "issued",
          issuedOrderId: "order-1",
          issuedAt: "2026-01-01T00:00:00Z",
        },
        "card-issued-other-order": {
          id: "card-issued-other-order",
          status: "issued",
          issuedOrderId: "order-2",
          issuedAt: "2026-01-01T00:00:00Z",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    await expect(releaseLockedCardByOrder(db, "order-1")).resolves.toBe(1);
    expect(state.cards["card-issued-this-order"].status).toBe("available");
    expect(state.cards["card-issued-this-order"].issuedOrderId).toBeNull();
    expect(state.cards["card-issued-other-order"].status).toBe("issued");
    expect(state.cards["card-issued-other-order"].issuedOrderId).toBe("order-2");
  });
});

// ---------------------------------------------------------------------------
// releaseIssuedCard tests
// ---------------------------------------------------------------------------

describe("releaseIssuedCard", () => {
  beforeEach(() => {
    ops.length = 0;
    currentOrderId = null;
    currentProductId = null;
  });

  it("releases issued card back to available", async () => {
    currentOrderId = "order-1";
    const state = {
      cards: {
        "card-1": {
          id: "card-1",
          status: "issued",
          issuedOrderId: "order-1",
          issuedAt: "2026-01-01T00:00:00Z",
        },
      } as Record<string, Record<string, unknown>>,
    };
    const db = createMockDb(state);
    await releaseIssuedCard(db, "card-1", "order-1");
    expect(state.cards["card-1"].status).toBe("available");
    expect(state.cards["card-1"].issuedOrderId).toBeNull();
    expect(state.cards["card-1"].issuedAt).toBeNull();
  });

  it("is callable without throwing for non-existent card", async () => {
    const db = createMockDb({ cards: {} });
    await expect(releaseIssuedCard(db, "nonexistent", "order-x")).resolves.toBeUndefined();
  });
});
