import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const openServers = [];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      openServers.push(server);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function importHttpClient() {
  const url = new URL("./http-client.mjs", import.meta.url);
  url.searchParams.set("test", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

afterEach(async () => {
  while (openServers.length > 0) {
    await close(openServers.pop());
  }
});

describe("scripts/http-client request", () => {
  it("retries JSON requests once when smoke traffic hits HTTP 429", async () => {
    let calls = 0;
    const server = http.createServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.01",
        });
        res.end(JSON.stringify({ ok: false, error: "请求过于频繁" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, calls }));
    });
    await listen(server);

    const previousBaseUrl = process.env.BASE_URL;
    const address = server.address();
    process.env.BASE_URL = `http://127.0.0.1:${address.port}`;
    try {
      const { request } = await importHttpClient();
      await expect(request("/limited", { max429Retries: 1 })).resolves.toEqual({ ok: true, calls: 2 });
      expect(calls).toBe(2);
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.BASE_URL;
      } else {
        process.env.BASE_URL = previousBaseUrl;
      }
    }
  });
});
