import type { ProjectReadProjection } from '@platform/project';

/** Report installed read/write adapters, independently of the current data epoch. */
export function supportedDataFormats(projection?: ProjectReadProjection): string[] {
  return projection &&
    typeof projection.name === 'function' &&
    typeof projection.authoritative === 'function' &&
    typeof projection.findIdByName === 'function' &&
    typeof projection.saveNameSync === 'function'
    ? ['project-name-v2-authority']
    : [];
}
