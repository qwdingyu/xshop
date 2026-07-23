/**
 * 邮件服务单元测试
 *
 * 测试覆盖：
 * - escapeHtml：HTML 转义（&<>"'）
 * - interpolate：模板插值与条件渲染
 * - getTemplate：模板获取与 subject 匹配
 * - sendEmail：完整发送流程（含重试逻辑、DB 日志写入、fetch 失败处理）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildIssuedDeliveryTemplateData, escapeHtml, interpolate, getTemplate, sendEmail } from "./email-service";
import type { DbType } from "../db/client";

// ── 纯函数测试 ──────────────────────────────────────────────────────────────

describe("escapeHtml", () => {
  it("转义 & 符号", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("转义 < 符号", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("转义 > 符号", () => {
    expect(escapeHtml("5 > 3")).toBe("5 &gt; 3");
  });

  it("转义双引号", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("转义单引号", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("同时转义所有 5 个特殊字符", () => {
    expect(escapeHtml("<a href=\"test\">Tom & Jerry's</a>"))
      .toBe("&lt;a href=&quot;test&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
  });

  it("正常字符串不做额外转义", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });

  it("空字符串返回空", () => {
    expect(escapeHtml("")).toBe("");
  });
});

describe("email access template", () => {
  it("contains the verification code and expiry placeholders", () => {
    const template = getTemplate("email_access_code");
    expect(template?.subject).toContain("验证码");
    expect(template?.html).toContain("{{code}}");
    expect(template?.html).toContain("{{expiresInMinutes}}");
  });
});

describe("buildIssuedDeliveryTemplateData", () => {
  it("keeps the first card in legacy fields and includes every additional card", () => {
    const result = buildIssuedDeliveryTemplateData([
      { accountLabel: "ACC-1", deliverySecret: "SECRET-1", deliveryNote: "NOTE-1" },
      { accountLabel: "ACC-2", deliverySecret: "SECRET-2", deliveryNote: "NOTE-2" },
      { accountLabel: "", deliverySecret: "SECRET-3", deliveryNote: "" },
    ]);

    expect(result).toMatchObject({
      accountLabel: "ACC-1",
      deliverySecret: "SECRET-1",
      deliveryNote: "NOTE-1",
    });
    expect(result.additionalDeliveries).toContain("卡密 2");
    expect(result.additionalDeliveries).toContain("SECRET-2");
    expect(result.additionalDeliveries).toContain("卡密 3");
    expect(result.additionalDeliveries).toContain("SECRET-3");
  });

  it("leaves additional card text to the existing HTML escaping boundary", () => {
    const data = buildIssuedDeliveryTemplateData([
      { deliverySecret: "SAFE" },
      { deliverySecret: "<script>alert('x')</script>" },
    ]);
    const template = getTemplate("order_issued");
    const html = interpolate(template?.html || "", {
      orderNo: "ORDER-1",
      productName: "Product",
      ...data,
    });

    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

describe("interpolate", () => {
  it("替换模板中的占位符", () => {
    const tpl = "Hello {{name}}, your order {{orderNo}} is ready";
    const result = interpolate(tpl, { name: "Alice", orderNo: "AB0001" });
    expect(result).toBe("Hello Alice, your order AB0001 is ready");
  });

  it("替换的值经过 HTML 转义", () => {
    const tpl = "Name: {{name}}";
    const result = interpolate(tpl, { name: "<script>alert('xss')</script>" });
    expect(result).toBe("Name: &lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  it("缺失的占位符替换为空字符串", () => {
    const tpl = "Hello {{name}}, your {{orderNo}}";
    const result = interpolate(tpl, { name: "Bob" });
    expect(result).toBe("Hello Bob, your ");
  });

  it("空的占位符内容不报错", () => {
    const tpl = "{{a}}{{b}}";
    const result = interpolate(tpl, {});
    expect(result).toBe("");
  });

  it("条件块：当变量存在时渲染内容", () => {
    const tpl = "before{{#if note}}<p>{{note}}</p>{{/if}}after";
    const result = interpolate(tpl, { note: "some note" });
    expect(result).toBe("before<p>some note</p>after");
  });

  it("条件块：当变量不存在时移除内容", () => {
    const tpl = "before{{#if note}}<p>{{note}}</p>{{/if}}after";
    const result = interpolate(tpl, {});
    expect(result).toBe("beforeafter");
  });

  it("条件块：当变量为空字符串时移除内容", () => {
    const tpl = "before{{#if note}}<p>{{note}}</p>{{/if}}after";
    const result = interpolate(tpl, { note: "" });
    expect(result).toBe("beforeafter");
  });

  it("嵌套内容中的占位符在条件成立时也被替换", () => {
    const tpl = "{{#if show}}<strong>{{title}}</strong>{{/if}}";
    const result = interpolate(tpl, { show: "yes", title: "Hello" });
    expect(result).toBe("<strong>Hello</strong>");
  });

  it("does not interpret template markers supplied inside escaped user data", () => {
    const tpl = "{{#if note}}<p>{{note}}</p>{{/if}}";
    const result = interpolate(tpl, { note: "{{/if}}<script>alert('x')</script>" });

    expect(result).toContain("{{/if}}&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(result).not.toContain("<script>");
  });

  it("多个条件块互不影响", () => {
    const tpl = "{{#if a}}A{{/if}}|{{#if b}}B{{/if}}";
    expect(interpolate(tpl, { a: "1" })).toBe("A|");
    expect(interpolate(tpl, { b: "1" })).toBe("|B");
    expect(interpolate(tpl, { a: "1", b: "1" })).toBe("A|B");
    expect(interpolate(tpl, {})).toBe("|");
  });

  it("多行模板中的完整插值行为（类似 order_issued 模板结构）", () => {
    const tpl = [
      "<h2>{{title}}</h2>",
      "<p>订单编号：{{orderNo}}</p>",
      "{{#if deliveryNote}}<p><strong>备注：</strong>{{deliveryNote}}</p>{{/if}}",
      "{{#if extra}}<p>{{extra}}</p>{{/if}}",
    ].join("\n");

    const result = interpolate(tpl, {
      title: "Test",
      orderNo: "AB123",
      deliveryNote: "请妥善保管",
    });

    expect(result).toContain("<h2>Test</h2>");
    expect(result).toContain("订单编号：AB123");
    expect(result).toContain('<p><strong>备注：</strong>请妥善保管</p>');
    expect(result).not.toContain("{{extra}}");
  });
});

describe("getTemplate", () => {
  it("返回已知模板的 subject 和 html", () => {
    const tpl = getTemplate("order_issued");
    expect(tpl).not.toBeNull();
    expect(tpl!.subject).toContain("卡密发放成功");
    expect(tpl!.html).toContain("{{deliverySecret}}");
    expect(tpl!.html).toContain("{{additionalDeliveries}}");
  });

  it("返回 order_pending 模板", () => {
    const tpl = getTemplate("order_pending");
    expect(tpl).not.toBeNull();
    expect(tpl!.subject).toContain("等待确认");
  });

  it("返回 order_paid 模板", () => {
    const tpl = getTemplate("order_paid");
    expect(tpl).not.toBeNull();
    expect(tpl!.subject).toContain("支付成功");
  });

  it("返回 order_expired 模板", () => {
    const tpl = getTemplate("order_expired");
    expect(tpl).not.toBeNull();
    expect(tpl!.subject).toContain("已过期");
  });

  it("返回 low_stock_warning 模板", () => {
    const tpl = getTemplate("low_stock_warning");
    expect(tpl).not.toBeNull();
    expect(tpl!.subject).toContain("库存预警");
  });

  it("未知模板名返回 null", () => {
    const tpl = getTemplate("nonexistent_template");
    expect(tpl).toBeNull();
  });

  it("空字符串返回 null", () => {
    const tpl = getTemplate("");
    expect(tpl).toBeNull();
  });
});

// ── sendEmail 测试 ──────────────────────────────────────────────────────────

/**
 * 创建 sendEmail 测试用的 Mock DB。
 * 支持 db.insert(emailLogs).values() 和 db.update(emailLogs).set().where()
 */
function createMockEmailDb(): DbType & { insertedLogs: unknown[]; updatedLogs: unknown[] } {
  const insertedLogs: unknown[] = [];
  const updatedLogs: unknown[] = [];

  const mockInsertResult = {
    catch: (handler: (err: unknown) => void) => {
      // 模拟 catch 链
      return { then: (resolve: () => void) => resolve(), catch: handler };
    },
    then: (resolve: (value: unknown) => void) => {
      resolve({ rowsAffected: 1 });
      return { catch: () => {} };
    },
  };

  const db = {
    insertedLogs,
    updatedLogs,

    insert: (_table: unknown) => ({
      values: (data: Record<string, unknown>) => {
        insertedLogs.push(data);
        return mockInsertResult;
      },
    }),

    update: (_table: unknown) => ({
      set: (data: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          updatedLogs.push(data);
          return Promise.resolve({ rowsAffected: 1 });
        },
      }),
    }),

    select: () => ({
      from: () => Promise.resolve([]),
      where: () => Promise.resolve([]),
    }),

    run: () => Promise.resolve({ rows: [] }),
    delete: () => ({
      where: () => Promise.resolve({ rowsAffected: 0 }),
    }),
  } as unknown as DbType & { insertedLogs: unknown[]; updatedLogs: unknown[] };

  return db;
}

describe("sendEmail", () => {
  const env = { resendApiKey: "re_test_key", emailFrom: "test@example.com" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("RESEND_API_KEY 未配置时返回失败", async () => {
    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      { resendApiKey: "", emailFrom: "" },
      { to: "buyer@test.com", template: "order_issued", templateData: { orderNo: "AB123" } }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("邮件服务未配置");
  });

  it("无效收件人邮箱时返回失败", async () => {
    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "invalid-email", template: "order_issued", templateData: {} }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("无效的收件人邮箱");
  });

  it("空收件人邮箱时返回失败", async () => {
    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "", template: "order_issued", templateData: {} }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("无效的收件人邮箱");
  });

  it("未知模板时返回失败", async () => {
    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "buyer@test.com", template: "unknown", templateData: {} }
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe("未知邮件模板: unknown");
  });

  it("成功发送邮件并通过 Resend API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email-123" }), { status: 200 })
    );

    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      {
        to: "buyer@test.com",
        template: "order_issued",
        templateData: { orderNo: "AB001", productName: "Test Product", accountLabel: "acc@test.com", deliverySecret: "secret123" }
      }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe("email-123");

    // 验证写入了邮件日志
    expect(db.insertedLogs.length).toBeGreaterThanOrEqual(1);

    // 验证调用了 Resend API
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer re_test_key",
        }),
      })
    );

    // 验证请求体包含正确的邮件内容
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]!.body as string);
    expect(body.to).toBe("buyer@test.com");
    expect(body.subject).toContain("卡密发放成功");
    expect(body.html).toContain("AB001");
    expect(body.html).toContain("secret123");
  });

  it("Resend API 返回 4xx 时不重试直接失败", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "invalid api key" }), { status: 401 })
    );

    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "buyer@test.com", template: "order_issued", templateData: { orderNo: "AB002", productName: "P", accountLabel: "A", deliverySecret: "S" } }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe("invalid api key");
    // 4xx 只调用一次 fetch（不重试）
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("Resend API 返回 5xx 时最多重试 3 次后失败", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "server error" }), { status: 500 })
    );

    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "buyer@test.com", template: "order_issued", templateData: { orderNo: "AB003", productName: "P", accountLabel: "A", deliverySecret: "S" } }
    );

    expect(result.ok).toBe(false);
    // 5xx 重试 3 次
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("网络错误时最多重试 3 次后失败", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network timeout"));

    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "buyer@test.com", template: "order_issued", templateData: { orderNo: "AB004", productName: "P", accountLabel: "A", deliverySecret: "S" } }
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("network timeout");
    // 网络错误重试 3 次
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it("5xx 错误第三次重试时成功", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch");
    // 前两次 500，第三次 200
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "server error" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "server error" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "email-retry-ok" }), { status: 200 }));

    const db = createMockEmailDb();
    const result = await sendEmail(
      db,
      env,
      { to: "buyer@test.com", template: "order_issued", templateData: { orderNo: "AB005", productName: "P", accountLabel: "A", deliverySecret: "S" } }
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe("email-retry-ok");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("写入邮件日志（pending 状态）并在发送成功后更新为 sent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email-log-test" }), { status: 200 })
    );

    const db = createMockEmailDb();
    await sendEmail(
      db,
      env,
      { to: "buyer@test.com", template: "order_issued", templateData: { orderNo: "AB006", productName: "P", accountLabel: "A", deliverySecret: "S" } }
    );

    // 验证有插入日志记录
    expect(db.insertedLogs.length).toBeGreaterThanOrEqual(1);
    const insertedLog = db.insertedLogs[0] as Record<string, unknown>;
    expect(insertedLog.toEmail).toBe("buyer@test.com");
    expect(insertedLog.template).toBe("order_issued");
    expect(insertedLog.status).toBe("pending");

    // 验证更新日志为 sent
    expect(db.updatedLogs.length).toBeGreaterThanOrEqual(1);
    const updatedLog = db.updatedLogs[0] as Record<string, unknown>;
    expect(updatedLog.status).toBe("sent");
  });

  it("使用自定义 from 地址", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email-custom-from" }), { status: 200 })
    );

    const db = createMockEmailDb();
    await sendEmail(
      db,
      env,
      {
        to: "buyer@test.com",
        template: "order_issued",
        templateData: { orderNo: "AB007", productName: "P", accountLabel: "A", deliverySecret: "S" },
        from: "custom@example.com"
      }
    );

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse(fetchCall[1]!.body as string);
    expect(body.from).toBe("custom@example.com");
  });
});
