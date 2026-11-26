/**
 * 官方 CUA 帧契约（producer 侧唯一实现，语义对齐 ZCode 4.0.0 官方 CLI bundle）。
 *
 * 帧 = 一张窗口栅格 + 紧邻其后的权威引用
 * `{"image_ref":{"actionable":true,"frame_id":...,"height":...,"width":...}}`。
 * 权威只属于紧贴 raster 的那个 content 块，它绑定的是模型真正收到的那张图；
 * `structuredContent` 里出现真 JSON `image_ref` 权威即视为未配对权威（契约 §8）。
 *
 * 官方实现要点（与 2026-08-14 契约文档一致）：
 * - `image_ref` 的键集必须**恰好**是 actionable/frame_id/height/width 四个键，
 *   多一个字段（如 authority）就不再是官方权威；width/height 受 4096 与
 *   16777216 像素的硬上限约束（值级解析），文本级判定不施加尺寸上限。
 * - 栅格信封必须是**完整**的 PNG（IHDR + IDAT + IEND，末尾无尾随字节）或 JPEG
 *   （SOF + SOS + EOI），尺寸/媒体类型必须与 `image_ref` 一致。
 * - EXIF 方向必须是 1（canonical），非 1 即判非规范栅格。
 * - 拒绝面分两路且不可合并：模型只拿到一句不含 frame_id、不含落盘路径的通用
 *   「重新截图」提示；具体判据放在结果 `_meta` 的
 *   `zcode.cua/frame-integrity-rejections-v1` 上，由宿主单独读取。
 * - 判据里的 frame_id 必须脱敏（替换成 "the frame"），模型上下文里不得出现帧号。
 */
import { createHash } from "node:crypto";

/** 官方 `_meta` 键：producer 签发的最终栅格完整性元数据。 */
export const OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY = "zcode.cua/official-frame-integrity-v1";
/** 官方 `_meta` 键：拒绝判据（宿主诊断用，模型侧看不到）。 */
export const OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY = "zcode.cua/frame-integrity-rejections-v1";
/** 宿主内部用的官方帧授权标记。 */
export const OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION = "official_cua_frame_v1";
/** 官方帧的内联 base64 预算（200 KiB）。 */
export const OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;

/** 官方 `image_ref` 精确键集（排序后 join 比对）。 */
const IMAGE_REF_KEY_SET = "actionable,frame_id,height,width";
/** 官方 producer 完整性元数据的精确键集。 */
const INTEGRITY_KEY_SET = "frame_id,height,media_type,sha256,version,width";
/** 官方文本级权威判定的长度上限。 */
const MAX_TEXT_LENGTH = 1024;
/** 官方扫描 JSON 对象候选时的文本总长上限。 */
const MAX_SCAN_LENGTH = 263168;
/** 官方扫描 JSON 对象候选时的候选数量上限。 */
const MAX_CANDIDATE_COUNT = 2048;
/** 官方 `image_ref` 尺寸上限（值级解析）。 */
const MAX_DIMENSION = 4096;
/** 官方 `image_ref` 总像素上限（值级解析）。 */
const MAX_PIXELS = 16777216;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** JPEG SOFn 标记（0xC0..0xCF 中排除 DHT/JPG/DAC）。 */
const JPEG_SOF_MARKERS = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
/** canonical base64：字符集 + 补齐 + 往返一致（Buffer.from 会静默丢弃非法字符）。 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

// ─────────────────────────────────────────────────────────── 基础工具

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatByteSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

// ─────────────────────────────────────────────────────────── 权威引用解析

/**
 * 官方 `parseFrameImageRefTextLocal`：整段文本必须是一个**单键** JSON 对象，
 * 其 image_ref 的键集恰好是 actionable/frame_id/height/width。
 * 文本级判定不施加尺寸上限（上限只在值级解析里），也不接受任何额外字段。
 */
export function parseFrameImageRefTextLocal(text) {
  if (typeof text !== "string") return undefined;
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !isRecord(parsed.image_ref)) {
    return undefined;
  }
  const ref = parsed.image_ref;
  if (
    Object.keys(ref).sort().join(",") === IMAGE_REF_KEY_SET &&
    typeof ref.frame_id === "string" &&
    ref.frame_id.length > 0 &&
    Number.isInteger(ref.width) &&
    ref.width > 0 &&
    Number.isInteger(ref.height) &&
    ref.height > 0 &&
    ref.actionable === true
  ) {
    return { frameId: ref.frame_id, width: ref.width, height: ref.height };
  }
  return undefined;
}

/** 官方 `isOfficialCuaImageRefText`：整块即权威引用。 */
export function isOfficialCuaImageRefText(text) {
  return parseFrameImageRefTextLocal(text) !== undefined;
}

/**
 * 官方 `scanJsonObjectCandidates`：在文本里扫描长度不超过 1024 的 JSON 对象候选，
 * 返回 "found" / "none" / "overflow"。
 */
function scanJsonObjectCandidates(text, predicate) {
  if (typeof text !== "string") return "none";
  const limit = Math.min(text.length, MAX_SCAN_LENGTH);
  const stack = [];
  let candidateCount = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < limit; index += 1) {
    const char = text[index];
    if (inString) {
      if (!escaped && char === '"') inString = false;
      escaped = !escaped && char === "\\";
      if (char !== "\\") escaped = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      stack.push(index);
      continue;
    }
    if (char !== "}" || stack.length === 0) continue;
    const start = stack.pop();
    if (index + 1 - start > MAX_TEXT_LENGTH) continue;
    candidateCount += 1;
    if (candidateCount > MAX_CANDIDATE_COUNT) return "overflow";
    if (predicate(text.slice(start, index + 1))) return "found";
  }
  return text.length > MAX_SCAN_LENGTH ? "overflow" : "none";
}

/**
 * 官方 `containsOfficialCuaImageRefCredentialText`：整块是权威引用，或文本里
 * 嵌着一个完整的权威引用对象。挂钩子的上下文里出现即视为凭据泄漏。
 */
export function containsOfficialCuaImageRefCredentialText(text) {
  if (isOfficialCuaImageRefText(text)) return true;
  return scanJsonObjectCandidates(text, isOfficialCuaImageRefText) !== "none";
}

/**
 * 官方 `hasTopLevelJsonKey`：判断文本的**顶层** JSON 对象是否带某个键。
 * 只看顶层，不匹配嵌套对象里的同名字段。
 */
function hasTopLevelJsonKey(text, key) {
  let index = 0;
  while (/\s/u.test(text[index] ?? "")) index += 1;
  if (text[index] !== "{") return false;
  index += 1;
  let depth = 1;
  let expectingKey = true;
  while (index < text.length && depth > 0) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      for (; index < text.length; ) {
        const inner = text[index];
        if (!escaped && inner === '"') break;
        escaped = !escaped && inner === "\\";
        if (inner !== "\\") escaped = false;
        index += 1;
      }
      if (index >= text.length) return false;
      if (depth === 1 && expectingKey) {
        let parsed;
        try {
          parsed = JSON.parse(text.slice(start, index + 1));
        } catch {
          return false;
        }
        let next = index + 1;
        while (/\s/u.test(text[next] ?? "")) next += 1;
        if (text[next] === ":" && parsed === key) return true;
      }
      index += 1;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (depth === 1 && char === ":") expectingKey = false;
    else if (depth === 1 && char === ",") expectingKey = true;
    index += 1;
  }
  return false;
}

/**
 * 官方 `parseOfficialCuaImageRefValue`：值级权威解析（带尺寸硬上限）。
 * 返回 undefined = 不是权威引用；null = 是 image_ref 但字段不合法。
 */
export function parseOfficialCuaImageRefValue(value) {
  if (!isRecord(value) || !("image_ref" in value)) return undefined;
  if (Object.keys(value).length !== 1 || !isRecord(value.image_ref)) return null;
  const ref = value.image_ref;
  if (
    Object.keys(ref).sort().join(",") !== IMAGE_REF_KEY_SET ||
    typeof ref.frame_id !== "string" ||
    ref.frame_id.length === 0 ||
    !Number.isInteger(ref.width) ||
    ref.width <= 0 ||
    ref.width > MAX_DIMENSION ||
    !Number.isInteger(ref.height) ||
    ref.height <= 0 ||
    ref.height > MAX_DIMENSION ||
    ref.width * ref.height > MAX_PIXELS ||
    ref.actionable !== true
  ) {
    return null;
  }
  return { frameId: ref.frame_id, width: ref.width, height: ref.height };
}

/**
 * 官方 `parseOfficialCuaImageRef`（块级）：只认 text 块。
 * 超长文本退化为"顶层是否带 image_ref 键"的粗判：带键 → null（畸形），否则 undefined。
 */
function parseOfficialCuaImageRefBlock(block) {
  if (block?.type !== "text" || typeof block.text !== "string") return undefined;
  if (block.text.length > MAX_TEXT_LENGTH) {
    return hasTopLevelJsonKey(block.text, "image_ref") ? null : undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    return undefined;
  }
  return parseOfficialCuaImageRefValue(parsed);
}

/**
 * 官方 `containsImageRefAuthority`：在任意结构里找权威引用。
 * 字符串按"整段是权威引用或内嵌权威引用"判定；对象若带 image_ref 属性则按值级解析判定。
 */
export function containsImageRefAuthority(value) {
  const stack = [value];
  const seen = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (containsOfficialCuaImageRefCredentialText(current)) return true;
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (Object.hasOwn(current, "image_ref")) {
      if (parseOfficialCuaImageRefValue({ image_ref: current.image_ref }) != null) return true;
    }
    for (const item of Object.values(current)) stack.push(item);
  }
  return false;
}

/** 官方 `containsImageRefAuthorityText`：文本级权威判定。 */
export function containsImageRefAuthorityText(text) {
  return containsOfficialCuaImageRefCredentialText(text);
}

// ─────────────────────────────────────────────────────────── 栅格信封

/**
 * 官方 `readCompletePngEnvelope`：只接受**完整**的 PNG —— 首个块必须是 IHDR(13)，
 * 必须有 IDAT，必须以 IEND 结束且文件末尾无尾随字节。eXIf 块带方向。
 */
export function readCompletePngEnvelope(bytes) {
  if (!Buffer.isBuffer(bytes)) return undefined;
  let offset = 8;
  let width = 0;
  let height = 0;
  let chunkIndex = 0;
  let hasImageData = false;
  const orientations = new Set();
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return undefined;
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) return undefined;
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) return undefined;
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      if (width <= 0 || height <= 0) return undefined;
    } else if (type === "IHDR") {
      return undefined;
    }
    if (type === "eXIf") {
      const orientation = readTiffOrientation(bytes.subarray(offset + 8, offset + 8 + length));
      if (orientation === null) return undefined;
      if (orientation !== undefined) orientations.add(orientation);
    }
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || !hasImageData || end !== bytes.length || orientations.size > 1) {
        return undefined;
      }
      return {
        mimeType: "image/png",
        width,
        height,
        orientation: orientations.values().next().value,
      };
    }
    offset = end;
    chunkIndex += 1;
  }
  return undefined;
}

/**
 * 官方 `readJpegExifOrientation`：APP1 段里的 EXIF 方向。
 * 返回 undefined = 段内没有方向；null = 段畸形。
 */
export function readJpegExifOrientation(bytes) {
  if (!Buffer.isBuffer(bytes)) return undefined;
  if (bytes.length < 6 || !bytes.subarray(0, 6).equals(Buffer.from("Exif\0\0"))) {
    return undefined;
  }
  return readTiffOrientation(bytes.subarray(6));
}

/**
 * 官方 `readTiffOrientation`：解析 TIFF IFD 里的 Orientation(274)。
 * 返回 undefined = 没有方向条目；null = TIFF 畸形。
 */
export function readTiffOrientation(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8) return null;
  const marker = bytes.subarray(0, 2).toString("ascii");
  const littleEndian = marker === "II";
  if (!littleEndian && marker !== "MM") return null;
  const readUInt16 = (offset) =>
    littleEndian ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const readUInt32 = (offset) =>
    littleEndian ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (readUInt16(2) !== 42) return null;
  const directoryOffset = readUInt32(4);
  if (directoryOffset > bytes.length - 2) return null;
  const entryCount = readUInt16(directoryOffset);
  if (entryCount > 256 || directoryOffset + 2 + entryCount * 12 > bytes.length) return null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = directoryOffset + 2 + index * 12;
    if (readUInt16(entry) !== 274) continue;
    if (readUInt16(entry + 2) !== 3 || readUInt32(entry + 4) !== 1) return null;
    const value = readUInt16(entry + 8);
    return value >= 1 && value <= 8 ? value : null;
  }
  return undefined;
}

/**
 * 官方 `readRasterEnvelopeIdentity`（bundle 内 `B1n`）：PNG 或 JPEG 的完整信封身份。
 * 返回 {mimeType,width,height,orientation?}；不是完整信封时返回 undefined。
 */
function readRasterEnvelope(bytes) {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return readCompletePngEnvelope(bytes);
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    return undefined;
  }
  let width;
  let height;
  const orientations = new Set();
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset];
    offset += 1;
    // EOI：完整 JPEG 的扫描数据到这里就结束了（后续字节不构成可解码信封）。
    if (marker === 0xd9) return undefined;
    // 独立标记（TEM、RSTn）没有长度字段。
    if (marker === 0x01 || (marker >= 208 && marker <= 216)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return undefined;
      const segmentHeight = bytes.readUInt16BE(offset + 3);
      const segmentWidth = bytes.readUInt16BE(offset + 5);
      if (segmentWidth <= 0 || segmentHeight <= 0 || width !== undefined) return undefined;
      width = segmentWidth;
      height = segmentHeight;
    }
    if (marker === 0xe1) {
      const orientation = readJpegExifOrientation(bytes.subarray(offset + 2, offset + length));
      if (orientation === null) return undefined;
      if (orientation !== undefined) orientations.add(orientation);
    }
    if (marker === 0xda) {
      if (
        length < 2 ||
        offset + length >= bytes.length - 2 ||
        width === undefined ||
        height === undefined ||
        orientations.size > 1
      ) {
        return undefined;
      }
      return {
        mimeType: "image/jpeg",
        width,
        height,
        orientation: orientations.values().next().value,
      };
    }
    offset += length;
  }
  return undefined;
}

/**
 * 官方 `readRasterEnvelopeIdentity` 的公开导出面（上游 v4.0.0 d.ts 声明为
 * `(input: unknown) => { algorithm: string } | undefined`）。
 * 接受原始字节或 canonical base64 文本；返回摘要算法与信封字段，
 * 不是完整信封时返回 undefined。
 */
export function readRasterEnvelopeIdentity(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : typeof input === "string"
      ? decodeCanonicalBase64(input)
      : undefined;
  if (!bytes) return undefined;
  const envelope = readRasterEnvelope(bytes);
  if (!envelope) return undefined;
  return { algorithm: "sha256", ...envelope };
}

/**
 * 上游工作树遗留的尺寸读取面（官方对应面是 readRasterEnvelopeIdentity）。
 * 只读文件头尺寸，不解码像素；媒体类型不符时返回 undefined。
 */
export function readRasterDimensions(bytes, mediaType) {
  const envelope = readRasterEnvelope(bytes);
  if (!envelope) return undefined;
  if (mediaType && envelope.mimeType !== mediaType) return undefined;
  return { width: envelope.width, height: envelope.height };
}

// ─────────────────────────────────────────────────────────── base64

/**
 * 官方 `decodeCanonicalBase64`：长度补齐 + 字符集 + 往返一致。
 * 返回 Buffer，非法输入返回 undefined。
 */
export function decodeCanonicalBase64(data) {
  if (typeof data !== "string") return undefined;
  if (data.length === 0 || data.length % 4 !== 0 || !CANONICAL_BASE64.test(data)) {
    return undefined;
  }
  const bytes = Buffer.from(data, "base64");
  return bytes.length > 0 && bytes.toString("base64") === data ? bytes : undefined;
}

/**
 * 官方 `decodeCanonicalBoundedImageDataUrl`：模型侧 image 块（dataUrl + mediaType）
 * 的有界 canonical base64 解码。
 */
export function decodeCanonicalBoundedImageDataUrl(image) {
  if (!isRecord(image)) return undefined;
  const mediaType = typeof image.mediaType === "string" ? image.mediaType : undefined;
  const dataUrl = typeof image.dataUrl === "string" ? image.dataUrl : undefined;
  if (!mediaType || !dataUrl) return undefined;
  const prefix = `data:${mediaType};base64,`;
  if (!dataUrl.startsWith(prefix)) return undefined;
  const payload = dataUrl.slice(prefix.length);
  if (
    payload.length === 0 ||
    payload.length > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES ||
    payload.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(payload)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(payload, "base64");
  return bytes.length > 0 && bytes.toString("base64") === payload ? bytes : undefined;
}

/** 官方 `hasCanonicalBoundedImageDataUrl`。 */
export function hasCanonicalBoundedImageDataUrl(image) {
  return decodeCanonicalBoundedImageDataUrl(image) !== undefined;
}

// ─────────────────────────────────────────────────────────── 帧对查找

/**
 * 官方 `findOfficialCuaFrameContentPair`：结果里必须只有一张 image，
 * 其后紧邻一个权威引用文本块，且全文只有那一个权威引用文本块。
 * 官方这条判定作用在**模型内容**形态（mediaType + dataUrl）上。
 */
export function findOfficialCuaFrameContentPair(content) {
  if (!Array.isArray(content)) return undefined;
  const images = content
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block?.type === "image");
  if (images.length !== 1) return undefined;
  const [image] = images;
  const imageRefIndex = image.index + 1;
  const imageRef = content[imageRefIndex];
  const uniqueAuthority =
    imageRef?.type === "text" &&
    isOfficialCuaImageRefText(imageRef.text) &&
    content.filter((block) => block?.type === "text" && isOfficialCuaImageRefText(block.text)).length === 1;
  if (
    !uniqueAuthority ||
    typeof image.block.mediaType !== "string" ||
    !image.block.mediaType.startsWith("image/") ||
    !hasCanonicalBoundedImageDataUrl(image.block)
  ) {
    return undefined;
  }
  return {
    image: image.block,
    imageIndex: image.index,
    imageRef,
    imageRefIndex,
  };
}

/**
 * 官方 `attestOfficialCuaFrameContent`：出站 attestation。
 * 只在整对权威帧唯一、引用可解析、栅格是 canonical 有界 dataUrl 时签发。
 */
export function attestOfficialCuaFrameContent(content, expectedKind) {
  if (expectedKind !== undefined && expectedKind !== OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION) {
    return undefined;
  }
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  const reference = parseOfficialCuaImageRefBlock(pair.imageRef);
  const bytes = decodeCanonicalBoundedImageDataUrl(pair.image);
  if (!reference || !bytes) return undefined;
  return {
    kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    frameId: reference.frameId,
    mediaType: pair.image.mediaType,
    width: reference.width,
    height: reference.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

// ─────────────────────────────────────────────────────────── 拒绝判据

/**
 * 官方 `redactFrameIds`：把判据里的 frame_id 换成 "the frame"。
 * 模型侧提示不得出现帧号，也不得出现落盘路径。
 */
export function redactFrameIds(reasons, frameIds) {
  const ids = [...new Set(frameIds)].filter((id) => id.length > 0).sort((a, b) => b.length - a.length);
  return reasons.map((reason) => {
    let text = reason;
    for (const id of ids) {
      text = text.replaceAll(`frame ${id}`, "the frame").replaceAll(id, "the frame");
    }
    return text
      .replaceAll(/\bframe\s+frame-[0-9a-z]+\b/giu, "the frame")
      .replaceAll(/\bframe-[0-9a-z]+\b/giu, "the frame");
  });
}

/**
 * 上游工作树遗留的同名面：从判据文本里自行抽出帧号再脱敏。
 */
export function redactFrameIdsFromRejectionReasons(reasons) {
  const ids = new Set();
  for (const reason of reasons) {
    for (const match of reason.matchAll(/\bframe\s+([^\s;.]+)/gu)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return redactFrameIds(reasons, ids);
}

/**
 * 官方 `inspectReferenceBlock`：权威引用块自身的判据。
 * 解析失败 → 字段不合法；同结果内重复 frame_id → 重复；引用未紧贴 image → 不配对。
 */
function inspectReferenceBlock(frameIds, rejectedReasons, reference, index, result) {
  if (reference === null) {
    rejectedReasons.push("image_ref is malformed or contains unsupported fields");
    return;
  }
  if (frameIds.has(reference.frameId)) {
    rejectedReasons.push(`frame ${reference.frameId} is duplicated in one result`);
  }
  frameIds.add(reference.frameId);
  if (result.content[index - 1]?.type !== "image") {
    rejectedReasons.push(`frame ${reference.frameId} is not immediately preceded by its image`);
  }
}

/**
 * 官方 `inspectImageBlock`：栅格块的判据。
 * 字节形态、内联预算、信封尺寸/媒体类型、EXIF 方向、宿主完整解码逐项判定。
 */
async function inspectImageBlock(input) {
  const data = typeof input.block.data === "string" ? input.block.data : undefined;
  const mediaType = typeof input.block.mimeType === "string" ? input.block.mimeType : undefined;
  if (!data || !mediaType?.startsWith("image/") || data.startsWith("data:")) {
    return `frame ${input.reference.frameId} has invalid image bytes or media type`;
  }
  const size = data.length;
  if (size > OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES) {
    return `frame ${input.reference.frameId} is ${formatByteSize(size)}, exceeding the immutable inline limit ${formatByteSize(OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES)}`;
  }
  const bytes = decodeCanonicalBase64(data);
  if (!bytes) {
    return `frame ${input.reference.frameId} has invalid image bytes or media type`;
  }
  const envelope = readRasterEnvelope(bytes);
  if (
    !envelope ||
    envelope.mimeType !== mediaType ||
    envelope.width !== input.reference.width ||
    envelope.height !== input.reference.height
  ) {
    return `frame ${input.reference.frameId} image header does not match image_ref dimensions/media type`;
  }
  if (envelope.orientation !== undefined && envelope.orientation !== 1) {
    return `frame ${input.reference.frameId} carries a non-canonical EXIF orientation`;
  }
  const decoded = await validateFullyDecodedRaster({
    data: bytes,
    imageProcessorPort: input.imageProcessorPort,
    mimeType: mediaType,
    reference: input.reference,
    signal: input.signal,
  });
  return decoded ? `frame ${input.reference.frameId} ${decoded}` : undefined;
}

/** 官方 `inspectContentBlocks`：逐块走引用与栅格判据。 */
async function inspectContentBlocks(input) {
  for (const [index, block] of input.result.content.entries()) {
    const reference = input.parsedReferences[index];
    if (reference !== undefined) {
      inspectReferenceBlock(input.frameIds, input.rejectedReasons, reference, index, input.result);
    }
    if (block?.type !== "image") continue;
    const next = input.parsedReferences[index + 1];
    if (!next || next === null) {
      input.rejectedReasons.push("image is missing a valid adjacent image_ref");
      continue;
    }
    const reason = await inspectImageBlock({
      block,
      imageProcessorPort: input.imageProcessorPort,
      reference: next,
      signal: input.signal,
    });
    if (reason) input.rejectedReasons.push(reason);
  }
}

/**
 * 官方 `validateProducerFrameIntegrity`：把 producer 签发的完整性元数据与
 * 最终栅格逐字段对齐。元数据缺失或字段不符即不是权威帧。
 */
function validateProducerFrameIntegrity(result, parsedReferences) {
  const index = result.content.findIndex((block) => block?.type === "image");
  if (index < 0 || index > result.content.length - 2) {
    return "producer frame integrity cannot bind an unpaired image";
  }
  const reference = parsedReferences[index + 1];
  const image = result.content[index];
  if (!reference || !image || image.type !== "image") {
    return "producer frame integrity cannot bind an invalid image pair";
  }
  const integrity = result._meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY];
  if (!isRecord(integrity)) {
    return "producer frame integrity metadata is missing";
  }
  if (Object.keys(integrity).sort().join(",") !== INTEGRITY_KEY_SET) {
    return "producer frame integrity metadata has unsupported fields";
  }
  const data = typeof image.data === "string" ? image.data : undefined;
  const bytes = data ? decodeCanonicalBase64(data) : undefined;
  const mediaType = typeof image.mimeType === "string" ? image.mimeType : undefined;
  if (!bytes || !mediaType) {
    return "producer frame integrity image bytes are invalid";
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return integrity.version === 1 &&
    integrity.frame_id === reference.frameId &&
    integrity.width === reference.width &&
    integrity.height === reference.height &&
    integrity.media_type === mediaType &&
    integrity.sha256 === digest
    ? undefined
    : "producer frame integrity metadata does not match the final raster";
}

/**
 * 官方 `validateFullyDecodedRaster`：宿主图像处理器必须能**原样**解码这张图，
 * 不缩放、尺寸与媒体类型都与 image_ref 一致；否则像素坐标不可信。
 */
async function validateFullyDecodedRaster(input) {
  if (!input.imageProcessorPort) {
    return "cannot be fully decoded by the host image processor";
  }
  try {
    const processed = await input.imageProcessorPort.resizeToFit(
      {
        data: input.data,
        maxDimension: Math.max(input.reference.width, input.reference.height),
        mediaType: input.mimeType,
      },
      { signal: input.signal },
    );
    const unchanged = Buffer.from(processed.data).equals(input.data);
    return processed.resized === false &&
      unchanged &&
      processed.mediaType === input.mimeType &&
      processed.originalWidth === input.reference.width &&
      processed.originalHeight === input.reference.height &&
      processed.width === input.reference.width &&
      processed.height === input.reference.height
      ? undefined
      : "decoded pixels do not match the immutable image_ref";
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return "cannot be fully decoded by the host image processor";
  }
}

// ─────────────────────────────────────────────────────────── 保留帧结果

/**
 * 官方 `preserveOfficialCuaFrameResult`：官方帧的原子门禁。
 *
 * 任一判据失败即整帧拒绝：模型只拿到一句不含 frame_id、不含落盘路径的通用提示，
 * 具体判据落在 `_meta["zcode.cua/frame-integrity-rejections-v1"]` 上。
 * 官方实现拒绝时**只**返回 {content, isError, _meta}，原结果里的其它 content
 * 块与 structuredContent 都不再下发。
 */
export async function preserveOfficialCuaFrameResult(result, options = {}) {
  if (!result || !Array.isArray(result.content)) return result;
  const rejectedReasons = [];
  const frameIds = new Set();
  const parsedReferences = result.content.map(parseOfficialCuaImageRefBlock);
  const imageCount = result.content.filter((block) => block?.type === "image").length;
  if (containsImageRefAuthority(result.structuredContent)) {
    rejectedReasons.push("structuredContent contains an unpaired image_ref authority");
  }
  if (imageCount > 1) {
    rejectedReasons.push(
      `result contains ${imageCount} images; official CUA allows exactly one final raster per result`,
    );
  }
  await inspectContentBlocks({
    imageProcessorPort: options.imageProcessorPort,
    parsedReferences,
    rejectedReasons,
    result,
    signal: options.signal,
    frameIds,
  });
  if (imageCount === 1) {
    const reason = validateProducerFrameIntegrity(result, parsedReferences);
    if (reason) rejectedReasons.push(reason);
  }
  if (rejectedReasons.length === 0) return result;

  const knownFrameIds = new Set();
  for (const reference of parsedReferences) {
    if (reference?.frameId) knownFrameIds.add(reference.frameId);
  }
  for (const frameId of frameIds) knownFrameIds.add(frameId);
  const redacted = redactFrameIds(rejectedReasons, knownFrameIds);
  return {
    content: [
      {
        type: "text",
        text:
          "Official CUA image rejected by the exact-raster integrity gate. No raster authority or local artifact path was exposed; capture a new image and retry." +
          ` Cause: ${redacted.join("; ")}.`,
      },
    ],
    isError: true,
    _meta: {
      [OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY]: [...redacted],
    },
  };
}

/**
 * 官方 `parseOfficialCuaImageRef` 的公开导出面。
 * 官方块级解析返回 {frameId,width,height}（畸形时为 null、缺权威时为 undefined）；
 * 这里映射成上游声明的 `{ authority: string }` 形状（authority 即 frame_id），
 * 并保留官方字段供诊断。
 */
export function parseOfficialCuaImageRef(text) {
  const parsed = parseOfficialCuaImageRefBlock({ type: "text", text });
  if (!parsed) return undefined;
  return {
    authority: parsed.frameId,
    frameId: parsed.frameId,
    width: parsed.width,
    height: parsed.height,
  };
}
