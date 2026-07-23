import { describe, expect, it, vi } from "vitest";
import { createMediaImageKey, detectMediaImage, getManagedMediaImageContentType, isManagedMediaImageKey, validateMediaImage } from "./media-image";

describe("media image validation", () => {
  it("detects supported signatures without trusting the filename", () => {
    expect(detectMediaImage(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.contentType).toBe("image/jpeg");
    expect(detectMediaImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.contentType).toBe("image/png");
    expect(detectMediaImage(new TextEncoder().encode("RIFF0000WEBP"))?.contentType).toBe("image/webp");
    expect(detectMediaImage(new TextEncoder().encode("0000ftypavif0000000000000000"))?.contentType).toBe("image/avif");
  });

  it("rejects a declared MIME that does not match the file signature", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const file = new File([bytes], "spoof.png", { type: "image/png" });
    expect(() => validateMediaImage(file, bytes)).toThrow("图片内容与文件类型不一致");
  });

  it("generates only constrained immutable object keys", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("123e4567-e89b-42d3-a456-426614174000");
    const key = createMediaImageKey("webp");
    expect(key).toBe("images/123e4567-e89b-42d3-a456-426614174000.webp");
    expect(isManagedMediaImageKey(key)).toBe(true);
    expect(getManagedMediaImageContentType(key)).toBe("image/webp");
    expect(isManagedMediaImageKey("../private/backup.zip")).toBe(false);
    expect(getManagedMediaImageContentType("../private/backup.zip")).toBeNull();
  });
});
