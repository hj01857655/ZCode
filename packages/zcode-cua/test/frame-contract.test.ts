import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  attestOfficialCuaFrameContent,
  containsImageRefAuthority,
  containsOfficialCuaImageRefCredentialText,
  findOfficialCuaFrameContentPair,
  isOfficialCuaImageRefText,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
  OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY,
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  parseOfficialCuaImageRef,
  preserveOfficialCuaFrameResult,
} from "../frame-contract.js";

/** 完整 PNG（IHDR + IDAT + IEND，1x1）。官方信封判定要求结构完整且末尾无尾随字节。 */
function completePng(width: number, height: number): Buffer {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** 只有文件头的 PNG：官方信封判定拒绝（缺 IDAT/IEND）。 */
function pngHeaderOnly(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

const imageBytes = completePng(1, 1);
const image = { type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" };
const ref = { frame_id: "state-1", width: 1, height: 1, actionable: true };
const refBlock = { type: "text", text: JSON.stringify({ image_ref: ref }) };
const integrity = {
  version: 1,
  frame_id: ref.frame_id,
  width: ref.width,
  height: ref.height,
  media_type: "image/png",
  sha256: createHash("sha256").update(imageBytes).digest("hex"),
};
/** 宿主图像处理器：官方要求原样解码（不缩放、尺寸与媒体类型都对得上）。 */
const exactInspector = {
  resizeToFit: async (request: { data: Buffer; mediaType: string }) => ({
    data: request.data,
    mediaType: request.mediaType,
    originalHeight: 1,
    originalWidth: 1,
    height: 1,
    resized: false,
    width: 1,
  }),
};

/** 官方拒绝面返回 {content, isError, _meta}；上游 d.ts 的泛型返回面看不到这些字段，
 * 测试里显式投影成官方形状再断言。 */
type OfficialRejectionView = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function rejectionView(result: unknown): OfficialRejectionView {
  return result as OfficialRejectionView;
}

describe("官方 CUA 帧引用判定", () => {
  it("只承认单键、键集恰好是四字段的 image_ref 块", () => {
    expect(isOfficialCuaImageRefText(refBlock.text)).toBe(true);
    expect(containsOfficialCuaImageRefCredentialText(refBlock.text)).toBe(true);
    expect(parseOfficialCuaImageRef(refBlock.text)).toMatchObject({ authority: ref.frame_id });
    expect(containsImageRefAuthority(refBlock.text)).toBe(true);

    expect(isOfficialCuaImageRefText('{"image_ref":"frame-1"}')).toBe(false);
    expect(isOfficialCuaImageRefText('{"image_ref":{"frame_id":"x","width":1,"height":1}}')).toBe(false);
    expect(isOfficialCuaImageRefText(`text ${refBlock.text}`)).toBe(false);
    expect(isOfficialCuaImageRefText(JSON.stringify({ image_ref: ref, extra: 1 }))).toBe(false);
  });

  it("image_ref 多一个字段（如 authority）就不再是官方权威", () => {
    const withAuthority = JSON.stringify({
      image_ref: { ...ref, authority: "signed" },
    });
    expect(isOfficialCuaImageRefText(withAuthority)).toBe(false);
    expect(parseOfficialCuaImageRef(withAuthority)).toBeUndefined();
    expect(containsImageRefAuthority(withAuthority)).toBe(false);
  });

  it("attestation 要求唯一权威对与 canonical 有界 dataUrl", () => {
    const modelImage = {
      type: "image",
      mediaType: "image/png",
      dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    };
    expect(
      attestOfficialCuaFrameContent([modelImage, refBlock], OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION),
    ).toMatchObject({ kind: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION });
    expect(attestOfficialCuaFrameContent([modelImage, refBlock], "other_kind")).toBeUndefined();
    // 两张权威图：坐标属于哪张不可判定。
    expect(attestOfficialCuaFrameContent([modelImage, refBlock, modelImage, refBlock])).toBeUndefined();
    expect(attestOfficialCuaFrameContent([modelImage])).toBeUndefined();
  });

  it("find 返回相邻图文对的下标", () => {
    const modelImage = {
      type: "image",
      mediaType: "image/png",
      dataUrl: `data:image/png;base64,${imageBytes.toString("base64")}`,
    };
    const pair = findOfficialCuaFrameContentPair([
      { type: "text", text: "tree" },
      modelImage,
      refBlock,
    ]);
    expect(pair?.imageIndex).toBe(1);
    expect(pair?.imageRefIndex).toBe(2);
    expect(findOfficialCuaFrameContentPair([modelImage])).toBeUndefined();
  });
});

describe("preserveOfficialCuaFrameResult", () => {
  it("校验信息与图像一致时原样返回", async () => {
    const result = {
      content: [image, refBlock],
      _meta: { [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: integrity },
    };
    await expect(
      preserveOfficialCuaFrameResult(result, { imageProcessorPort: exactInspector }),
    ).resolves.toBe(result);
  });

  it("校验信息与图像不一致时整帧拒绝，判据落在 _meta 上", async () => {
    const result = {
      content: [image, refBlock],
      _meta: { [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: { ...integrity, sha256: "deadbeef" } },
    };
    const preserved = rejectionView(
      await preserveOfficialCuaFrameResult(result, {
        imageProcessorPort: exactInspector,
      }),
    );
    expect(preserved.isError).toBe(true);
    expect(preserved.content).toHaveLength(1);
    expect(preserved.content[0].type).toBe("text");
    const text = preserved.content[0].text ?? "";
    expect(text).toContain("Official CUA image rejected by the exact-raster integrity gate.");
    expect(text).toContain("Cause:");
    // 模型侧提示不得含 frame_id。
    expect(text).not.toContain(ref.frame_id);
    const reasons = preserved._meta?.[
      OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY
    ] as string[];
    expect(Array.isArray(reasons)).toBe(true);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).not.toContain(ref.frame_id);
    }
  });

  it("非 canonical base64 或尺寸不符时整帧拒绝", async () => {
    const nonCanonical = { ...image, data: image.data.slice(0, -1) };
    const wrongDims = { ...image, data: completePng(2, 2).toString("base64") };
    for (const broken of [nonCanonical, wrongDims]) {
      const preserved = rejectionView(
        await preserveOfficialCuaFrameResult(
          { content: [broken, refBlock, { type: "text", text: "tree" }] },
          { imageProcessorPort: exactInspector },
        ),
      );
      expect(preserved.isError).toBe(true);
      expect(preserved.content).toHaveLength(1);
      expect(preserved.content[0].type).toBe("text");
    }
  });

  it("栅格信封不完整时整帧拒绝", async () => {
    const headerOnly = { ...image, data: pngHeaderOnly(1, 1).toString("base64") };
    const preserved = rejectionView(
      await preserveOfficialCuaFrameResult(
        { content: [headerOnly, refBlock] },
        { imageProcessorPort: exactInspector },
      ),
    );
    expect(preserved.isError).toBe(true);
    expect(preserved.content[0].type).toBe("text");
  });

  it("超过 200 KiB base64 上限时整帧拒绝", async () => {
    const oversized = { ...image, data: Buffer.alloc(160 * 1024).toString("base64") };
    const preserved = rejectionView(
      await preserveOfficialCuaFrameResult(
        { content: [oversized, refBlock] },
        { imageProcessorPort: exactInspector },
      ),
    );
    expect(preserved.isError).toBe(true);
    expect(preserved.content[0].type).toBe("text");
  });

  it("单结果出现多个 frame_id 时整帧拒绝", async () => {
    const secondRef = {
      type: "text",
      text: JSON.stringify({ image_ref: { ...ref, frame_id: "state-2" } }),
    };
    const preserved = rejectionView(
      await preserveOfficialCuaFrameResult(
        { content: [image, refBlock, image, secondRef] },
        { imageProcessorPort: exactInspector },
      ),
    );
    expect(preserved.isError).toBe(true);
    const reasons = preserved._meta?.[
      OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY
    ] as string[];
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).not.toContain(ref.frame_id);
      expect(reason).not.toContain("state-2");
    }
  });

  it("structuredContent 里的未配对权威同样触发拒绝", async () => {
    const preserved = rejectionView(
      await preserveOfficialCuaFrameResult(
        {
          content: [image, refBlock],
          structuredContent: { image_ref: ref },
          _meta: { [OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]: integrity },
        },
        { imageProcessorPort: exactInspector },
      ),
    );
    expect(preserved.isError).toBe(true);
    const reasons = preserved._meta?.[
      OFFICIAL_CUA_FRAME_INTEGRITY_REJECTIONS_META_KEY
    ] as string[];
    expect(reasons.join("; ")).toContain("unpaired image_ref authority");
  });
});
