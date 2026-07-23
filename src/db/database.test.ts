import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn((options: unknown) => ({ options })));
const createDb = vi.hoisted(() => vi.fn((client: unknown) => ({ client })));

vi.mock("@libsql/client", () => ({ createClient }));
vi.mock("./client", () => ({ createDb }));

describe("initDatabase connection cache", () => {
  beforeEach(() => {
    vi.resetModules();
    createClient.mockClear();
    createDb.mockClear();
  });

  it("reuses a client only when both URL and token match", async () => {
    const { initDatabase } = await import("./database");
    const first = initDatabase({ TURSO_URL: "libsql://shop", TURSO_TOKEN: "token-a" });
    const same = initDatabase({ TURSO_URL: "libsql://shop", TURSO_TOKEN: "token-a" });
    const rotated = initDatabase({ TURSO_URL: "libsql://shop", TURSO_TOKEN: "token-b" });

    expect(same.client).toBe(first.client);
    expect(same.db).toBe(first.db);
    expect(rotated.client).not.toBe(first.client);
    expect(rotated.db).not.toBe(first.db);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenNthCalledWith(2, { url: "libsql://shop", authToken: "token-b" });
  });
});
