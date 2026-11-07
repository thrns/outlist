import "server-only";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import sharp, { type Metadata } from "sharp";
import { validateGitHubAvatarUrl } from "./github-avatar";

export const LOGO_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_OUTPUT_BYTES = 1_800_000;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 16_000_000;
const MAX_OUTPUT_DIMENSION = 512;
const CONNECT_TIMEOUT_MS = 4_000;
const READ_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 15_000;
const ACCEPTED_FORMATS = new Set(["png", "jpeg", "webp"]);

export interface NormalizedLogo {
  bytes: Buffer;
  contentDigest: string;
  inputFormat: "png" | "jpeg" | "webp";
  width: number;
  height: number;
}

/** Download from the one automated image host; redirects and all other hosts are rejected. */
export async function downloadGitHubAvatar(sourceUrl: string, ownerId: number | string): Promise<Buffer> {
  const url = validateGitHubAvatarUrl(sourceUrl, ownerId);
  const controller = new AbortController();
  const totalTimer = setTimeout(() => controller.abort(new Error("total_timeout")), TOTAL_TIMEOUT_MS);
  const connectTimer = setTimeout(() => controller.abort(new Error("connect_timeout")), CONNECT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "image/png,image/jpeg,image/webp" } });
  } catch {
    clearTimeout(totalTimer);
    throw new Error("GitHub avatar download failed or timed out.");
  } finally {
    clearTimeout(connectTimer);
  }
  try {
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Redirects are not accepted for logo sources.");
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("GitHub avatar source did not return an image response.");
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > LOGO_MAX_INPUT_BYTES)) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Logo source exceeds the download size limit.");
    }
    return await readBoundedBody(response, controller);
  } finally {
    clearTimeout(totalTimer);
  }
}

/** Read an explicitly selected operator file without following a symlink. */
export async function readOperatorLogoFile(filePath: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > LOGO_MAX_INPUT_BYTES) {
      throw new Error("Operator image file is empty or exceeds the size limit.");
    }
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const readLength = Math.min(chunk.byteLength, LOGO_MAX_INPUT_BYTES - size + 1);
      const { bytesRead } = await handle.read(chunk, 0, readLength, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > LOGO_MAX_INPUT_BYTES) throw new Error("Operator image file exceeds the size limit.");
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) throw error;
    throw new Error("Could not safely read the selected operator image file.");
  } finally {
    await handle?.close();
  }
}

/** Decode by file content, enforce resource limits, strip metadata, and emit normalized WebP. */
export async function normalizeLogoImage(input: Buffer | Uint8Array): Promise<NormalizedLogo> {
  if (input.byteLength < 1 || input.byteLength > LOGO_MAX_INPUT_BYTES) {
    throw new Error("Logo image input is empty or exceeds the size limit.");
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS, sequentialRead: true }).metadata();
  } catch {
    throw new Error("Logo image is malformed, truncated, or unsupported.");
  }
  if (!metadata.format || !ACCEPTED_FORMATS.has(metadata.format) || !metadata.width || !metadata.height
    || metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION
    || metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) !== 1) {
    throw new Error("Logo image format or dimensions are not allowed.");
  }

  let output: Buffer;
  try {
    output = await sharp(input, { failOn: "error", limitInputPixels: MAX_PIXELS, sequentialRead: true })
      .rotate()
      .resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 88, effort: 4 })
      .toBuffer();
  } catch {
    throw new Error("Logo image could not be safely decoded and normalized.");
  }
  if (output.byteLength > LOGO_MAX_OUTPUT_BYTES) throw new Error("Normalized logo exceeds the Storage object size limit.");
  const dimensions = await sharp(output).metadata();
  if (!dimensions.width || !dimensions.height || dimensions.width > MAX_OUTPUT_DIMENSION || dimensions.height > MAX_OUTPUT_DIMENSION) {
    throw new Error("Normalized logo dimensions are invalid.");
  }
  return {
    bytes: output,
    contentDigest: createHash("sha256").update(output).digest("hex"),
    inputFormat: metadata.format as NormalizedLogo["inputFormat"],
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function readBoundedBody(response: Response, controller: AbortController): Promise<Buffer> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const timer = setTimeout(() => controller.abort(new Error("read_timeout")), READ_TIMEOUT_MS);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new Error("Logo source read failed or timed out.");
      } finally {
        clearTimeout(timer);
      }
      if (result.done) break;
      size += result.value.byteLength;
      if (size > LOGO_MAX_INPUT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Logo source exceeds the download size limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}
