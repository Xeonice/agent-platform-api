/** Process lifecycle port: interface adapters register their actual work while
 * the platform composition root owns the implementation and retirement scope. */
export const COORDINATOR_GATEWAY_WORK_FACTORY = Symbol('CoordinatorGatewayWorkFactory');
export interface CoordinatorGatewayWork {
  run<T>(work: () => Promise<T>): Promise<T>;
}
export interface CoordinatorGatewayWorkFactory {
  register(
    id: 'terminal.gateway' | 'sandbox.tasks-gateway',
    stopAdmission: () => void,
  ): CoordinatorGatewayWork;
}
