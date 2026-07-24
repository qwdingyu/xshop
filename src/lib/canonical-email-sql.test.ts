import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { canonicalBuyerEmail } from "../../shared/canonical-email";
import { eqCanonicalBuyerEmail, sqlCanonicalBuyerEmail } from "./canonical-email-sql";

/**
 * 用真实 libSQL 求值 SQL 表达式，并与 JS canonicalBuyerEmail 对齐。
 * 这是限购/限流“同人判定”的正确性底座，不能只测 mock。
 */
async function evaluateCanonicalSql(email: string): Promise<string> {
  const client = createClient({ url: "file::memory:" });
  const db = createDb(client);
  try {
    // drizzle 需要 from 某表；用 sqlite 临时表承载输入
    await client.execute("CREATE TABLE t (buyer_email TEXT NOT NULL)");
    await client.execute({ sql: "INSERT INTO t (buyer_email) VALUES (?)", args: [email] });
    const rows = await db.all<{ c: string }>(sql`SELECT ${sqlCanonicalBuyerEmail(sql`buyer_email`)} AS c FROM t`);
    return String(rows[0]?.c ?? "");
  } finally {
    client.close();
  }
}

describe("sqlCanonicalBuyerEmail aligns with canonicalBuyerEmail", () => {
  it.each([
    "  Buyer@Example.COM ",
    "user+promo@example.com",
    "a+1@gmail.com",
    "a.b.c@gmail.com",
    "a.b.c@googlemail.com",
    "a.b@outlook.com",
    "First.Last+tag@gmail.com",
    "simple@test.com",
    "dots.only@company.co.uk",
    "u++double@gmail.com",
    "endplus+@gmail.com",
  ])("matches JS for %s", async (email) => {
    const fromJs = canonicalBuyerEmail(email);
    const fromSql = await evaluateCanonicalSql(email);
    expect(fromSql).toBe(fromJs);
  });

  it("eqCanonicalBuyerEmail matches Gmail +tag / dots variants as the same person", async () => {
    const client = createClient({ url: "file::memory:" });
    const db = createDb(client);
    try {
      await client.execute("CREATE TABLE orders_like (buyer_email TEXT NOT NULL)");
      await client.execute({
        sql: "INSERT INTO orders_like (buyer_email) VALUES (?), (?), (?)",
        args: ["a.b+promo@gmail.com", "other@example.com", "ab@gmail.com"],
      });
      const canonical = canonicalBuyerEmail("a.b+promo@gmail.com");
      const rows = await db.all<{ buyer_email: string }>(sql`
        SELECT buyer_email FROM orders_like
        WHERE ${eqCanonicalBuyerEmail(sql`buyer_email`, canonical)}
        ORDER BY buyer_email
      `);
      expect(rows.map((r) => r.buyer_email)).toEqual(["a.b+promo@gmail.com", "ab@gmail.com"]);
    } finally {
      client.close();
    }
  });
});
