import type { OpenAPIObject } from '@nestjs/swagger';
import { PROJECT_NAME_MAX_LENGTH } from '@platform/contracts';

/** nestjs-zod does not reflect custom code-point refinements into string limits. */
export function applyUnicodeLengthConstraints(document: OpenAPIObject): void {
  const project = document.components?.schemas?.['CreateProjectDto'];
  if (project === undefined || !('properties' in project)) return;
  const name = project.properties?.['name'];
  if (name === undefined || '$ref' in name) return;
  name.maxLength = PROJECT_NAME_MAX_LENGTH;
}
