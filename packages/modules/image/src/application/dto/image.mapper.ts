import { formatImageRef } from '@platform/contracts';
import type {
  ImageConfigDto,
  ImageManifestDto,
  ValidationIssueDto,
  ValidationOutcomeDto,
} from '@platform/contracts';
import type { Image } from '../../domain/entities/image.entity';
import type { ImageManifest } from '../../domain/entities/image-manifest.entity';
import type { ValidationOutcome } from '../../domain/value-objects/validation-outcome.vo';

/** Aggregate → wire. The ONE place image rows become DTOs (02 §5.1). */
export const ImageMapper = {
  toDto(manifest: ImageManifest, image: Image): ImageManifestDto {
    const findings = manifest.storedFindings();
    return {
      id: manifest.id,
      imageId: image.id,
      imageName: image.name,
      isBuiltin: image.isBuiltin,
      ref: formatImageRef(image.name, manifest.version),
      version: manifest.version,
      baseImage: manifest.baseImage,
      digest: manifest.digest,
      entrypointContract: manifest.entrypointContract,
      supportedRuntimes: manifest.supportedRuntimes,
      resourceDefaults: manifest.resourceDefaults,
      labelsRequired: manifest.labelsRequired,
      derivedFromDigest: manifest.derivedFromDigest,
      validationStatus: manifest.validation.status,
      validationErrors: findings === null ? null : findings.map(toIssueDto),
      isActive: manifest.isActive,
      imageConfig: toConfigDto(manifest),
      registeredAt: manifest.registeredAt.toISOString(),
      /**
       * ⚠️ `resolvedAt` IS `registeredAt`, AND THAT IS AN IDENTITY, NOT A SHORTCUT.
       * The row is INSERTed at the instant the coordinate was resolved and its
       * `digest` is never UPDATEd afterwards (I-IMG-7), so the two timestamps describe
       * the same event. A second stored column could only ever drift from this one.
       */
      resolvedAt: manifest.registeredAt.toISOString(),
    };
  },

  outcome(outcome: ValidationOutcome): ValidationOutcomeDto {
    return {
      status: outcome.status,
      errors: outcome.errors.map(toIssueDto),
      warnings: outcome.warnings.map(toIssueDto),
    };
  },
};

/**
 * ⚠️ SECRET VALUES LEAVE AS `''`, ALWAYS (23 I-IMG-5). The ciphertext is not 「safe
 * enough to echo」: it goes into the DOM, into a screenshot, into a bug report, and a
 * blob plus a known plaintext is a gift. The empty string is also what the INBOUND
 * side reads as 「keep unchanged」, so a form round-trip is a no-op rather than a wipe.
 */
function toConfigDto(manifest: ImageManifest): ImageConfigDto | null {
  const config = manifest.config;
  if (config === null) return null;
  return {
    env: config.env.map((e) => ({
      key: e.key,
      value: e.secret ? '' : (e.value ?? ''),
      secret: e.secret,
    })),
    cmdOverride: config.cmdOverride,
  };
}

function toIssueDto(f: { path?: string; code: string; message: string }): ValidationIssueDto {
  return { path: f.path, code: f.code, message: f.message };
}
