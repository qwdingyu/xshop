/** 普通 JSON API 的请求体上限，保持现有接口的低资源占用与滥用防护。 */
export const DEFAULT_API_BODY_LIMIT_BYTES = 100 * 1024;

/** 商品封面和渠道 Logo 的单文件上限；小型商店不需要大图或分片上传。 */
export const MEDIA_IMAGE_FILE_LIMIT_BYTES = 5 * 1024 * 1024;

/** multipart/form-data 还包含 boundary 和字段头，预留少量协议开销。 */
export const MEDIA_UPLOAD_REQUEST_LIMIT_BYTES = MEDIA_IMAGE_FILE_LIMIT_BYTES + 64 * 1024;

const MEDIA_UPLOAD_PATH = "/admin/media/images";

/**
 * 只有经过管理员鉴权的图片上传端点允许较大的请求体。
 * 其他 API 继续使用 100KB 上限，避免为一个媒体能力扩大整个系统的攻击面。
 */
export function getApiBodyLimitBytes(path: string): number {
  return path === MEDIA_UPLOAD_PATH
    ? MEDIA_UPLOAD_REQUEST_LIMIT_BYTES
    : DEFAULT_API_BODY_LIMIT_BYTES;
}
