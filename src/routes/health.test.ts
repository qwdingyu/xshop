import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import type { DbType } from "../db/client";
import { healthRoute } from "./health";

describe("GET /health", () => {
  it("does not expose database exception details", async () => {
    const sensitiveMessage = "libsql://internal.example?authToken=secret-token";
    const db = {
      $client: {
        execute: vi.fn().mockRejectedValue(new Error(sensitiveMessage)),
      },
    } as unknown as DbType;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("db", db);
      await next();
    });
    app.route("/api", healthRoute);

    const res = await app.request("/api/health");
    const body = await res.json() as { database: string; error?: string };

    expect(res.status).toBe(200);
    expect(body.database).toBe("degraded");
    expect(body.error).toBe("database query failed");
    expect(JSON.stringify(body)).not.toContain(sensitiveMessage);
  });
});
