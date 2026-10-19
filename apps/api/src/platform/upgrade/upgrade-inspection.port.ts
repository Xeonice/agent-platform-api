import type { UpgradeInspector } from './upgrade-inspector';
export const UPGRADE_INSPECTOR = Symbol('UpgradeInspector');
export const UPGRADE_CONTRACT_SERVICE = Symbol('UpgradeContractService');
export const UPGRADE_PROJECTION = Symbol('UpgradeProjection');
/** Business inspection is an explicit port; importing it never loads runtime services. */
export type UpgradeInspectionPort = Pick<
  UpgradeInspector,
  | 'requiresProjectNameV2'
  | 'schema'
  | 'defaultImagesSnapshot'
  | 'sourceActual'
  | 'installedProof'
  | 'capture'
  | 'bootstrapProof'
  | 'entryBinding'
  | 'webBuild'
  | 'installerIdentity'
  | 'controlIdentity'
  | 'processObserve'
  | 'verifySourceArtifact'
  | 'validateSwitch'
  | 'authenticationContinuity'
  | 'continuity'
>;
