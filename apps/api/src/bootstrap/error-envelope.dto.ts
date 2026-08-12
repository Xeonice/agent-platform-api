import { createZodDto } from 'nestjs-zod';
import { ErrorEnvelopeSchema } from '@platform/contracts';

/**
 * The unified error envelope as a named OpenAPI component (docs/backend/04 §4,
 * shared/10 §6.8). Registered via `extraModels` at document build time so it is
 * always present in openapi.json for the frontend's cross-repo drift check,
 * even before individual endpoints annotate their error responses.
 * Class name === component name ("ErrorEnvelope").
 */
export class ErrorEnvelope extends createZodDto(ErrorEnvelopeSchema) {}
