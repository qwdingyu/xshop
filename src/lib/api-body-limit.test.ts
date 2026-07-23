import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_BODY_LIMIT_BYTES,
  MEDIA_UPLOAD_REQUEST_LIMIT_BYTES,
  getApiBodyLimitBytes,
} from "./api-body-limit";

describe("getApiBodyLimitBytes", () => {
  it("only raises the limit for the authenticated media upload path", () => {
    expect(getApiBodyLimitBytes("/admin/media/images")).toBe(MEDIA_UPLOAD_REQUEST_LIMIT_BYTES);
    expect(getApiBodyLimitBytes("/admin/products")).toBe(DEFAULT_API_BODY_LIMIT_BYTES);
    expect(getApiBodyLimitBytes("/media/images/example.webp")).toBe(DEFAULT_API_BODY_LIMIT_BYTES);
  });
});
