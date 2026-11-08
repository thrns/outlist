export type LogoOrigin = "official_site" | "editorial" | "submitted" | "provider_avatar";
export type LogoVerificationStatus = "pending_review" | "approved" | "rejected" | "revoked";

export interface LogoCandidate {
  id: string;
  projectId: string;
  origin: LogoOrigin;
  verificationStatus: LogoVerificationStatus;
  storagePath: string | null;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  attributionText: string | null;
  isPrimary: boolean;
  verifiedAt: string | null;
}

export type ResolvedProjectLogo =
  | {
      kind: "official_logo";
      presentationId: string;
      logoId: string;
      storagePath: string;
      mediaType: LogoCandidate["mediaType"];
      attributionText: string | null;
      label: "Official project logo";
    }
  | {
      kind: "provider_avatar";
      presentationId: string;
      logoId: string;
      storagePath: string;
      mediaType: LogoCandidate["mediaType"];
      attributionText: string | null;
      label: "GitHub owner avatar";
    }
  | {
      kind: "letter_fallback";
      presentationId: "letter-fallback-v1";
      fallbackCharacter: string;
      label: "No approved logo available";
    };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const storagePathPattern = new RegExp(`^(${UUID})/(${UUID})(?:/(${UUID}))?\\.(png|jpg|jpeg|webp)$`, "i");

export function isValidProjectLogoStoragePath(projectId: string, storagePath: string | null): storagePath is string {
  if (!storagePath) return false;
  const match = storagePathPattern.exec(storagePath);
  return Boolean(match && match[1]?.toLowerCase() === projectId.toLowerCase()
    && (!match[3] || match[4]?.toLowerCase() === "webp"));
}

/** Resolve only rows explicitly marked approved and backed by a project-scoped object path. */
export function resolveProjectLogo(
  projectName: string | null | undefined,
  projectId: string,
  candidates: readonly LogoCandidate[],
): ResolvedProjectLogo {
  const approved = candidates.filter((candidate) =>
    candidate.projectId === projectId
    && candidate.verificationStatus === "approved"
    && isValidProjectLogoStoragePath(projectId, candidate.storagePath),
  );

  const official = preferred(approved.filter((candidate) => candidate.origin !== "provider_avatar"));
  if (official) {
    return {
      kind: "official_logo",
      presentationId: `official-logo:${official.id}`,
      logoId: official.id,
      storagePath: official.storagePath!,
      mediaType: official.mediaType,
      attributionText: official.attributionText,
      label: "Official project logo",
    };
  }

  const avatar = preferred(approved.filter((candidate) => candidate.origin === "provider_avatar"));
  if (avatar) {
    return {
      kind: "provider_avatar",
      presentationId: `provider-avatar:${avatar.id}`,
      logoId: avatar.id,
      storagePath: avatar.storagePath!,
      mediaType: avatar.mediaType,
      attributionText: avatar.attributionText,
      label: "GitHub owner avatar",
    };
  }

  return {
    kind: "letter_fallback",
    presentationId: "letter-fallback-v1",
    fallbackCharacter: firstLetterOrNumber(projectName),
    label: "No approved logo available",
  };
}

function preferred(candidates: readonly LogoCandidate[]): LogoCandidate | undefined {
  return [...candidates].sort((left, right) =>
    Number(right.isPrimary) - Number(left.isPrimary)
    || timestamp(right.verifiedAt) - timestamp(left.verifiedAt)
    || left.id.localeCompare(right.id),
  )[0];
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstLetterOrNumber(value: string | null | undefined): string {
  const normalized = (value ?? "").normalize("NFKC");
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (const item of segmenter.segment(normalized)) {
    const visible = item.segment.match(/[\p{L}\p{N}]/u)?.[0];
    if (visible) {
      const uppercase = visible.toUpperCase();
      return Array.from(segmenter.segment(uppercase)).length === 1 ? uppercase : visible;
    }
  }
  return "?";
}
