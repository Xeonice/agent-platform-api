import type { UpgradeContractPlan } from '@platform/contracts';
import type { ContractRecord } from './upgrade-contract-store';
export const UPGRADE_CONTRACT_BUSINESS = Symbol('UpgradeContractBusiness');
type Awaitable<T> = T | Promise<T>;
export interface ContractBusinessFacts {
  complete: true;
  readEpoch: number;
  totalRows: number;
  newReadsConfirmed: boolean;
}
export interface ContractClearResult {
  cleared: number;
  complete: boolean;
}
/** Business semantics never run against control.db. A remote adapter first
 * obtains the original durable business receipt, then commits the control FSM. */
export interface UpgradeContractBusinessPort {
  projectNameAuthoritative(): Awaitable<boolean>;
  expandAttemptId(planDigest: string): Awaitable<string | null>;
  currentStartIdentity(): Awaitable<string>;
  ownerRoutes(): Awaitable<{ ownerId: string; endpoint: string }[]>;
  contractFacts(plan: UpgradeContractPlan): Awaitable<ContractBusinessFacts>;
  budget(plan: UpgradeContractPlan): Awaitable<void>;
  activate(record: ContractRecord, commit: (totalRows: number) => void): Awaitable<void>;
  clear(record: ContractRecord, commit: (batch: ContractClearResult) => void): Awaitable<void>;
}
