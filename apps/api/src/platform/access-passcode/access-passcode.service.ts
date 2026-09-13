import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@platform/shared-kernel';
import { AUDIT_RECORDER } from '@platform/contracts';
import type {
  AccessPasscodeAction,
  AccessPasscodeResult,
  AuditRecorder,
} from '@platform/contracts';
import { PasscodeService } from './passcode.service';
import { passcodeChangedRecord } from './access-audit';

/**
 * `PUT /api/system/access-passcode` (10 §6.6 / 11 §3.1) — the WRITE half of the access
 * passcode. The Guard, the lockout, the audit records and `POST /api/access/unlock`
 * already existed; this is the only thing that was missing.
 *
 * ⚠️ IT LIVES IN `access-passcode/`, NOT IN `system/`, EVEN THOUGH ITS ROUTE IS
 * `/api/system/...`. This folder carries the eslint time/random exemption (it is a
 * port implementation), and generating a passcode is precisely a `randomBytes` call.
 * Putting the generator in `system/` would mean either a second exemption or a
 * service that has to reach into this folder for its one interesting line.
 */
@Injectable()
export class AccessPasscodeService {
  constructor(
    private readonly passcodes: PasscodeService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUDIT_RECORDER) private readonly audit: AuditRecorder,
  ) {}

  apply(input: AccessPasscodeAction): AccessPasscodeResult {
    // ⚠️ FIRST, BEFORE ANY BRANCH. A deployment that pins `ACCESS_PASSCODE` cannot be
    // edited from in here — the platform does not own that file — so every action is
    // refused with the reason rather than half-applied (see `PasscodeService`'s note
    // on why neither "stored wins" nor "silently no-op" is acceptable).
    if (this.passcodes.source === 'env') {
      throw this.conflict(
        '此实例的访问口令由部署配置里的 ACCESS_PASSCODE 固定，无法在这里修改；' +
          '要改请改部署配置后重启，或先移除该环境变量再回到本页设置。',
      );
    }

    if (input.action === 'disable') {
      // idempotent: the target state is 「关」, and reaching it twice is not a conflict
      // (unlike `POST /api/system/init`, where the second call would rewrite a
      // 「这台机器什么时候开出来的」 timestamp — there is nothing like that here).
      const wasEnabled = this.passcodes.enabled;
      this.passcodes.setStoredPasscode(null, this.clock.now());
      if (wasEnabled) this.audit.record(passcodeChangedRecord('disable'));
      return { enabled: false };
    }

    const enabled = this.passcodes.enabled;
    if (input.action === 'enable' && enabled) {
      // ⛔ **不要把 API 字段名当操作指引。** 原文写着「请用 action: "regenerate"」——
      //    那是请求体里的一个字段值，对着界面的人根本不知道该在哪儿输入它。
      //    说他在界面上能做的那件事，字段名留给 openapi。
      throw this.conflict(
        '访问口令已经启用了。想换一个的话，用页面上的「重新生成口令」——' +
          '旧口令会立即作废并给出新的明文（已经登入的会话不受影响）。',
      );
    }
    if (input.action === 'regenerate' && !enabled) {
      throw this.conflict('访问口令还没启用，没有可以重新生成的口令；请先把访问口令打开。');
    }

    const plain = PasscodeService.generatePasscode();
    this.passcodes.setStoredPasscode(plain, this.clock.now());
    this.audit.record(passcodeChangedRecord(input.action));
    // ⚠️ THE ONLY TIME THE PLATFORM EVER SAYS THIS STRING. Nothing logs it, nothing
    // caches it, and `GET /api/system/settings` answers a boolean forever after.
    return { enabled: true, passcode: plain };
  }

  /**
   * 409 `INVALID_STATE` — 类 C（10 §6.8）：「请求没错，但此刻不行」。
   * `sideEffectFree: true` is earned structurally: every throw above happens before
   * `setStoredPasscode`, so nothing has been written when one fires.
   */
  private conflict(message: string): HttpException {
    return new HttpException(
      { code: 'INVALID_STATE', message, retryable: false, sideEffectFree: true },
      HttpStatus.CONFLICT,
    );
  }
}
