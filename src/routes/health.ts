import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { ok } from "../lib/http";

export const healthRoute = new Hono<AppEnv>();

healthRoute.get("/health", async (c) => {
  const db = c.get("db");

  // DB 不可用时直接返回 degraded 状态，不尝试查询
  if (!db) {
    return ok(c, {
      service: "eshop",
      storage: "turso",
      database: "degraded",
      error: "database unavailable"
    });
  }

  try {
    await db.$client.execute("SELECT 1");
    return ok(c, {
      service: "eshop",
      storage: "turso",
      database: "ok",
    });
  } catch (err) {
    console.error("[health] database check failed", err);
    return ok(c, {
      service: "eshop",
      storage: "turso",
      database: "degraded",
      error: "database query failed"
    });
  }
});
