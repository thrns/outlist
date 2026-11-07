import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { validateGitHubAvatarUrl } from "./github-avatar";
import { normalizeLogoImage, downloadGitHubAvatar, LOGO_MAX_INPUT_BYTES } from "./process";
import { isValidProjectLogoStoragePath, resolveProjectLogo, type LogoCandidate } from "./resolve";

const projectId = "11111111-1111-4111-8111-111111111111";
const approvedOfficial: LogoCandidate = {
  id: "22222222-2222-4222-8222-222222222222", projectId, origin: "editorial", verificationStatus: "approved",
  storagePath: `${projectId}/22222222-2222-4222-8222-222222222222.webp`, mediaType: "image/webp",
  attributionText: "Official brand mark, supplied by the project owner.", isPrimary: true, verifiedAt: "2026-11-01T00:00:00Z",
};
const approvedAvatar: LogoCandidate = {
  ...approvedOfficial, id: "33333333-3333-4333-8333-333333333333", origin: "provider_avatar", isPrimary: true,
  storagePath: `${projectId}/33333333-3333-4333-8333-333333333333.webp`, attributionText: "GitHub owner avatar; not verified as the project's official logo.",
};

describe("project logo resolution", () => {
  it("prefers approved official logos and preserves primary selection and attribution", () => {
    const resolved = resolveProjectLogo("Outlist", projectId, [approvedAvatar, approvedOfficial]);
    expect(resolved).toMatchObject({ kind: "official_logo", logoId: approvedOfficial.id, attributionText: approvedOfficial.attributionText });
  });

  it("keeps an approved official logo ahead of a primary approved avatar", () => {
    expect(resolveProjectLogo("Outlist", projectId, [{ ...approvedOfficial, isPrimary: false }, approvedAvatar]))
      .toMatchObject({ kind: "official_logo", logoId: approvedOfficial.id });
  });

  it("uses an approved provider avatar only when no official logo is approved", () => {
    expect(resolveProjectLogo("Outlist", projectId, [approvedAvatar])).toMatchObject({
      kind: "provider_avatar", logoId: approvedAvatar.id, label: "GitHub owner avatar",
    });
  });

  it.each([
    ["pending", "pending_review"], ["rejected", "rejected"], ["revoked", "revoked"],
  ])("excludes %s assets and supplies a deterministic single-glyph fallback", (_name, status) => {
    const excluded = { ...approvedOfficial, verificationStatus: status as LogoCandidate["verificationStatus"] };
    expect(resolveProjectLogo("  Café Project", projectId, [excluded])).toMatchObject({
      kind: "letter_fallback", presentationId: "letter-fallback-v1", fallbackCharacter: "C", label: "No approved logo available",
    });
  });

  it.each([
    ["", "?"], ["   ", "?"], ["123 Tool", "1"], ["💡 Compiler", "C"], ["e\u0301clair", "É"], ["ßeta", "ß"], ["!!!", "?"],
  ])("normalizes unusual project names safely: %j", (name, expected) => {
    expect(resolveProjectLogo(name, projectId, [])).toMatchObject({ kind: "letter_fallback", fallbackCharacter: expected });
  });

  it("requires a valid UUID project-scoped storage path", () => {
    expect(isValidProjectLogoStoragePath(projectId, approvedOfficial.storagePath)).toBe(true);
    expect(isValidProjectLogoStoragePath(projectId, "https://example.test/logo.webp")).toBe(false);
    expect(isValidProjectLogoStoragePath(projectId, `99999999-9999-4999-8999-999999999999/${approvedOfficial.id}.webp`)).toBe(false);
  });
});

describe("GitHub avatar source validation", () => {
  const valid = "https://avatars.githubusercontent.com/u/583231?v=4";

  it("accepts only the canonical GitHub avatar origin and owner path", () => {
    expect(validateGitHubAvatarUrl(valid, 583231)).toBe(valid);
  });

  it.each([
    "http://avatars.githubusercontent.com/u/583231?v=4",
    "https://avatars.githubusercontent.com.evil.test/u/583231?v=4",
    "https://github.com/owner.png",
    "https://avatars.githubusercontent.com/u/other?v=4",
    "https://avatars.githubusercontent.com/u/583231?redirect=https://evil.test",
    "https://user:pass@avatars.githubusercontent.com/u/583231?v=4",
    "https://avatars.githubusercontent.com:443/u/583231?v=4",
  ])("rejects unsafe or unexpected avatar URL %s", (url) => {
    expect(() => validateGitHubAvatarUrl(url, 583231)).toThrow();
  });

  beforeEach(() => vi.unstubAllGlobals());

  it("rejects redirects and does not follow arbitrary destinations", async () => {
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[0]).toBe(valid);
      void args[1];
      return new Response(null, { status: 302, headers: { location: "https://evil.test/image" } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(downloadGitHubAvatar(valid, 583231)).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("rejects an unsafe host before making a request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(downloadGitHubAvatar("https://example.test/u/583231", 583231)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("logo image processing", () => {
  it("normalizes actual PNG bytes to a clean WebP and computes a stable digest", async () => {
    const fixture = await sharp({ create: { width: 32, height: 24, channels: 4, background: "#472c78" } }).png().toBuffer();
    const first = await normalizeLogoImage(fixture);
    const second = await normalizeLogoImage(fixture);
    const metadata = await sharp(first.bytes).metadata();
    expect(first.inputFormat).toBe("png");
    expect(metadata.format).toBe("webp");
    expect(first.width).toBe(32);
    expect(first.height).toBe(24);
    expect(first.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.contentDigest).toBe(first.contentDigest);
  });

  it("rejects oversized, malformed, spoofed, and excessive-dimension inputs", async () => {
    await expect(normalizeLogoImage(Buffer.alloc(LOGO_MAX_INPUT_BYTES + 1))).rejects.toThrow(/size limit/i);
    await expect(normalizeLogoImage(Buffer.from("<html><body>not an image</body></html>"))).rejects.toThrow(/malformed|unsupported/i);
    await expect(normalizeLogoImage(Buffer.from("\x89PNG\r\n\x1a\n<html>spoofed</html>", "binary"))).rejects.toThrow(/malformed|unsupported/i);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    await expect(normalizeLogoImage(svg)).rejects.toThrow(/format|dimensions/i);
    const oversized = await sharp({ create: { width: 5000, height: 2, channels: 3, background: "white" } }).png().toBuffer();
    await expect(normalizeLogoImage(oversized)).rejects.toThrow(/format|dimensions/i);
  });
});
