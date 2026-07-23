import { MEDIA_IMAGE_FILE_LIMIT_BYTES } from "./api-body-limit";

export const MEDIA_IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type SupportedMediaImage = {
  contentType: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
  extension: "jpg" | "png" | "webp" | "avif";
};

const JPEG: SupportedMediaImage = { contentType: "image/jpeg", extension: "jpg" };
const PNG: SupportedMediaImage = { contentType: "image/png", extension: "png" };
const WEBP: SupportedMediaImage = { contentType: "image/webp", extension: "webp" };
const AVIF: SupportedMediaImage = { contentType: "image/avif", extension: "avif" };

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
}

/**
 * 根据文件签名识别图片类型，不能信任浏览器提交的 MIME 或文件扩展名。
 * 首期明确拒绝 SVG/GIF，避免脚本内容和动画资源扩大安全及性能边界。
 */
export function detectMediaImage(bytes: Uint8Array): SupportedMediaImage | null {
  if (bytes.length < 12) return null;
  if (hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) return JPEG;
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return PNG;
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return WEBP;

  // AVIF 使用 ISO BMFF 容器：第 4-7 字节为 ftyp，随后兼容品牌中包含 avif/avis。
  if (ascii(bytes, 4, 8) === "ftyp" && /avif|avis/.test(ascii(bytes, 8, 32))) return AVIF;
  return null;
}

export function validateMediaImage(file: File, bytes: Uint8Array): SupportedMediaImage {
  if (file.size <= 0) throw new Error("请选择非空图片文件");
  if (file.size > MEDIA_IMAGE_FILE_LIMIT_BYTES) throw new Error("图片不能超过 5MiB");

  const detected = detectMediaImage(bytes);
  if (!detected) throw new Error("仅支持 JPEG、PNG、WebP 或 AVIF 图片");

  // image/jpg 是部分旧客户端的非标准声明，可安全归一化为 image/jpeg。
  const declared = file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();
  if (declared && declared !== detected.contentType) {
    throw new Error("图片内容与文件类型不一致");
  }
  return detected;
}

export function createMediaImageKey(extension: SupportedMediaImage["extension"]): string {
  return `images/${crypto.randomUUID().toLowerCase()}.${extension}`;
}

export function isManagedMediaImageKey(key: string): boolean {
  return /^images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp|avif)$/.test(key);
}

/** 公开读取时从受控 key 推导 MIME，不能信任可被外部工具改写的 R2 对象元数据。 */
export function getManagedMediaImageContentType(key: string): SupportedMediaImage["contentType"] | null {
  if (!isManagedMediaImageKey(key)) return null;
  if (key.endsWith(".jpg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".avif")) return "image/avif";
  return null;
}
