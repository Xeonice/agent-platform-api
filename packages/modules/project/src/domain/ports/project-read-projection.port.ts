/** A compatible bridge read model may rename its persisted representation.
 * The authoritative project remains available while that model is unconfirmed. */
export interface ProjectReadProjection {
  name(projectId: string, authoritativeName: string): string | undefined;
  authoritative?(): boolean;
  findIdByName?(name: string): string | null;
  saveNameSync?(tx: Tx, projectId: string, name: string): string;
}
export const PROJECT_READ_PROJECTION = Symbol('ProjectReadProjection');
import type { Tx } from '@platform/shared-kernel/pure';
