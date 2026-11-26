// 官方 CUA 帧契约的公开类型面（ZCode 4.0.0 官方 CLI bundle 的 frame-contract 模块）。
//
// 下面 9 个上游符号是宿主与 producer 之间的契约面，不得删除或改签名；
// 官方 bundle 里另有若干辅助函数（完整 PNG 信封解析、EXIF/TIFF 方向、
// canonical base64 解码、frame_id 脱敏），这里按可读实现一并声明，宿主可选用。
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY: string;
export const OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY: string;
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION: string;
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES: number;

export declare function isOfficialCuaImageRefText(text: string): boolean;
export declare function containsOfficialCuaImageRefCredentialText(text: string): boolean;
export declare function containsImageRefAuthority(text: string): boolean;
export declare function containsImageRefAuthorityText(text: string): boolean;
export declare function parseOfficialCuaImageRef(text: string): { authority: string } | undefined;
export declare function readRasterEnvelopeIdentity(
  input: unknown,
): { algorithm: string } | undefined;
export declare function readRasterDimensions(
  bytes: unknown,
  mediaType: string,
): { width: number; height: number } | undefined;
export declare function preserveOfficialCuaFrameResult<
  T extends { content?: unknown; isError?: boolean },
>(result: T, options?: unknown): Promise<T>;
export interface OfficialCuaFrameAttestation {
  kind: string;
}
export declare function attestOfficialCuaFrameContent(
  content: unknown,
  expectedKind?: string,
): OfficialCuaFrameAttestation | undefined;
export interface OfficialCuaFrameContentPair {
  image: any;
  imageRef: any;
  imageRefIndex: number;
  imageIndex: number;
}
export declare function findOfficialCuaFrameContentPair(
  content: unknown,
): OfficialCuaFrameContentPair | undefined;
export declare function redactFrameIdsFromRejectionReasons(reasons: string[]): string[];

// ─────────────────────────────────────────── 官方辅助面（bundle 内的官方函数）
export declare function readCompletePngEnvelope(
  bytes: unknown,
): { mimeType: string; width: number; height: number; orientation?: number } | undefined;
export declare function readJpegExifOrientation(bytes: unknown): number | null | undefined;
export declare function readTiffOrientation(bytes: unknown): number | null | undefined;
export declare function decodeCanonicalBase64(data: unknown): Buffer | undefined;
export declare function decodeCanonicalBoundedImageDataUrl(image: unknown): Buffer | undefined;
export declare function hasCanonicalBoundedImageDataUrl(image: unknown): boolean;
export declare function redactFrameIds(reasons: string[], frameIds: string[]): string[];
