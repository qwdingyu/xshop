/**
 * Drizzle ORM mock factory for unit tests.
 *
 * Production code uses Drizzle ORM (db.select().from().where(), db.insert().values(), etc.)
 * but tests need to intercept these calls and return controlled data.
 *
 * This factory creates a mock object that satisfies the DbType interface
 * and allows tests to control return values for each ORM operation.
 *
 * Design:
 * - Chainable query builders (select/insert/update/delete) return configurable results
 * - db.run(sql`...`) is intercepted for raw SQL operations
 * - All operations are recorded for assertion
 */

// ── Operation log ──
export type OpLog = {
  type: "select" | "insert" | "update" | "delete" | "run";
  table?: string;
  sql?: string;
  data?: unknown;
  where?: unknown;
};

/**
 * Create a mock Drizzle ORM instance.
 *
 * @param config - Configuration for each operation type
 * @returns { db, ops } — db is the mock ORM, ops is the operation log
 */
export function createMockOrm(config: {
  /** Rows returned by select queries. Keyed by table name. */
  selectResults?: Record<string, unknown[]>;
  /** Default rows for any select not in selectResults */
  defaultSelectResult?: unknown[];
  /** Result of insert operations: { rowsAffected } */
  insertResult?: { rowsAffected: number };
  /** Result of update operations: returning rows */
  updateReturning?: unknown[];
  /** Result of delete operations */
  deleteResult?: { rowsAffected: number };
  /** Result of db.run(sql`...`) calls. Keyed by SQL pattern substring. */
  runResults?: Record<string, { rows: unknown[] }>;
  /** Default run result */
  defaultRunResult?: { rows: unknown[] };
} = {}) {
  const ops: OpLog[] = [];

  const selectResults = config.selectResults || {};
  const defaultSelectResult = config.defaultSelectResult || [];
  const insertResult = config.insertResult || { rowsAffected: 1 };
  const updateReturning = config.updateReturning || [];
  const deleteResult = config.deleteResult || { rowsAffected: 0 };
  const runResults = config.runResults || {};
  const defaultRunResult = config.defaultRunResult || { rows: [] };

  // Chainable where clause
  const whereChain = (table: string, result: unknown[]) => ({
    where: (_cond?: unknown) => ({
      ...whereChain(table, result),
      limit: (_n?: number) => Promise.resolve(result),
      orderBy: (..._args: unknown[]) => ({
        limit: (_n?: number) => Promise.resolve(result),
      }),
      then: (resolve: (v: unknown[]) => void) => Promise.resolve(result).then(resolve),
    }),
    limit: (_n?: number) => Promise.resolve(result),
    orderBy: (..._args: unknown[]) => ({
      limit: (_n?: number) => Promise.resolve(result),
    }),
    innerJoin: (..._args: unknown[]) => whereChain(table, result),
    then: (resolve: (v: unknown[]) => void) => Promise.resolve(result).then(resolve),
  });

  // Chainable insert
  const insertChain = (table: string) => ({
    values: (data: unknown) => {
      ops.push({ type: "insert", table, data });
      const onConflictChain = {
        onConflictDoUpdate: (_cfg?: unknown) => ({
          returning: (_cols?: unknown) => Promise.resolve([{ ...insertResult }]),
          then: (resolve: (v: unknown[]) => void) => Promise.resolve([{ ...insertResult }]).then(resolve),
        }),
        onConflictDoNothing: (_cfg?: unknown) => ({
          returning: (_cols?: unknown) => Promise.resolve([{ ...insertResult }]),
          then: (resolve: (v: unknown[]) => void) => Promise.resolve([{ ...insertResult }]).then(resolve),
        }),
        returning: (_cols?: unknown) => Promise.resolve([{ ...insertResult }]),
        then: (resolve: (v: unknown) => void) => Promise.resolve({ ...insertResult }).then(resolve),
      };
      return onConflictChain;
    },
  });

  // Chainable update
  const updateChain = (table: string) => ({
    set: (data: unknown) => {
      ops.push({ type: "update", table, data });
      const wherePart = {
        where: (_cond?: unknown) => ({
          returning: (_cols?: unknown) => {
            ops.push({ type: "update", table, data });
            return Promise.resolve(updateReturning);
          },
          then: (resolve: (v: unknown[]) => void) => Promise.resolve(updateReturning).then(resolve),
        }),
      };
      return wherePart;
    },
  });

  // Chainable delete
  const deleteChain = (table: string) => ({
    where: (_cond?: unknown) => {
      ops.push({ type: "delete", table });
      return Promise.resolve(deleteResult);
    },
  });

  // db.run(sql`...`) handler
  const runHandler = (sqlExpr: { getSQL?: () => string; query?: string; queryChunks?: unknown[] } & unknown) => {
    let sqlStr = "";

    // 优先尝试调用 .getSQL()（部分 drizzle 版本支持）
    if (typeof sqlExpr?.getSQL === "function") {
      try {
        sqlStr = sqlExpr.getSQL();
      } catch {
        sqlStr = "";
      }
    }

    // 回退：手动拼接 queryChunks（drizzle-orm sql`...` / sql.raw() 的标准结构）
    if (!sqlStr && Array.isArray(sqlExpr?.queryChunks)) {
      sqlStr = sqlExpr.queryChunks.map((chunk: unknown) => {
        if (typeof chunk === "string") return chunk;
        if (chunk && typeof chunk === "object" && Array.isArray((chunk as any).value)) {
          return (chunk as any).value.join("");
        }
        if (chunk && typeof chunk === "object") {
          return String((chunk as any).value ?? "");
        }
        return String(chunk ?? "");
      }).join("");
    }

    // 最终回退：直接 toString
    if (!sqlStr) {
      sqlStr = String(sqlExpr ?? "");
    }

    sqlStr = sqlStr.toLowerCase();
    ops.push({ type: "run", sql: sqlStr });

    for (const [pattern, result] of Object.entries(runResults)) {
      if (sqlStr.includes(pattern.toLowerCase())) {
        return Promise.resolve(result);
      }
    }
    return Promise.resolve(defaultRunResult);
  };

  const db = {
    select: (_cols?: unknown) => ({
      from: (table: { constructor?: { name?: string }; [key: string]: unknown } | unknown) => {
        const tableName = typeof table === "object" && table !== null
          ? (table as any).constructor?.name || String(table)
          : String(table);
        const result = selectResults[tableName] || defaultSelectResult;
        ops.push({ type: "select", table: tableName });
        return whereChain(tableName, result);
      },
    }),
    insert: (table: { constructor?: { name?: string }; [key: string]: unknown } | unknown) => {
      const tableName = typeof table === "object" && table !== null
        ? (table as any).constructor?.name || String(table)
        : String(table);
      return insertChain(tableName);
    },
    update: (table: { constructor?: { name?: string }; [key: string]: unknown } | unknown) => {
      const tableName = typeof table === "object" && table !== null
        ? (table as any).constructor?.name || String(table)
        : String(table);
      return updateChain(tableName);
    },
    delete: (table: { constructor?: { name?: string }; [key: string]: unknown } | unknown) => {
      const tableName = typeof table === "object" && table !== null
        ? (table as any).constructor?.name || String(table)
        : String(table);
      return deleteChain(tableName);
    },
    run: runHandler,
  };

  return { db, ops };
}
