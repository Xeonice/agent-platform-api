import {
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { UpgradeStore } from './upgrade-store';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';

const CONTROL_CONTROLLERS = new Set([
  'UpgradeController',
  'UpgradeInternalController',
  'UpgradeContractInternalController',
  'UpgradeInspectionController',
  'UpgradeContractBusinessController',
]);
/** Capture the original control ledger before the original handler starts.
 * Authentication still precedes frozen-admission rejection. Business HTTP and
 * the separately authenticated fixed attachment controller are unaffected. */
@Injectable()
export class UpgradeLedgerAdmissionInterceptor implements NestInterceptor {
  constructor(
    private readonly store: UpgradeStore,
    private readonly security: UpgradeSecurity,
  ) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const name = context.getClass().name;
    if (!CONTROL_CONTROLLERS.has(name)) return next.handle();
    const http = context.switchToHttp(),
      req = http.getRequest<Request>();
    if (name === 'UpgradeController')
      this.security.principal(req, http.getResponse<Response>(), this.store.instanceId);
    else this.security.internal(req, this.store.instanceId);
    return from(this.store.runLedgerWork(() => lastValueFrom(next.handle())));
  }
}
