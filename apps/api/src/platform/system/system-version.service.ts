import { Injectable } from '@nestjs/common';
import type { SystemVersionDto } from '@platform/contracts';
import { toIsoInstant } from '@platform/shared-kernel';
import { env } from '../config/env';

/**
 * `GET /api/system/version` 的产出方 —— 把构建期注入的版本三元组原样报出来。
 *
 * 逻辑本身只有三行，独立成 service 是为了装下 `builtAt` 那条校验（见下）：把它塞进
 * controller 会让一个「只读 env」的端点看起来不需要测试，而它恰恰有一条需要测的分支。
 */
@Injectable()
export class SystemVersionService {
  snapshot(): SystemVersionDto {
    return {
      version: env.appVersion,
      commit: env.appCommit,
      // ⚠️ 解析与归一化在 `@platform/shared-kernel` 的 `toIsoInstant` 里，**不在这里**。
      //    不是为了复用（目前只有一个调用方），是因为它要用 `Date` 构造器，而全仓禁令
      //    只在 `time.util.ts` 上开了口子 —— 那个口子的理由（「不读时钟，只转换第三方
      //    交来的绝对时刻」）逐字适用于本场景。在这里写一行 eslint-disable 等于在禁令上
      //    再开一个没人审过的洞。
      builtAt: toIsoInstant(env.appBuiltAt) ?? null,
    };
  }
}
