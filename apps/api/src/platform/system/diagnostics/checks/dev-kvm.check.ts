import { access, constants } from 'node:fs/promises';
import { platform } from 'node:os';
import { Injectable } from '@nestjs/common';
import type { DiagnoseCheck, DiagnoseCheckResult } from './check.types';

const KVM = '/dev/kvm';

/**
 * 诊断第 ② 项：**`/dev/kvm` 可用**（boxlite 微 VM 档位的硬前提）。
 *
 * ⚠️ **不可用不是 ❌ 而是 ⚠️。** boxlite 是可选档位（P21-5 §3：「⏸️ boxlite（micro-VM）
 * 未启用 · v2.0 开放」），一台只跑 aio 的机器上没有 `/dev/kvm` 完全正常。报成 ❌ 会让
 * 每一个正常的 docker 部署都顶着一个红灯，而红灯看久了就没人看了 —— 这一项报错的
 * 代价不是漏报，是把其余七项的可信度一起拉低。
 *
 * ⚠️ **macOS / Windows 上要说「本平台没有这个设备」，不能说「不可用」。** 后者听起来像
 * 一个可修的故障，而它不是：`/dev/kvm` 是 Linux KVM 的设备节点，macOS 上永远不会有。
 * 实测本机（darwin）就是这条分支 —— 说「不可用，请加载 kvm 模块」会把人送去做一件
 * 在他的操作系统上不存在的事。
 */
@Injectable()
export class DevKvmCheck implements DiagnoseCheck {
  readonly id = 'dev-kvm' as const;
  readonly label = '/dev/kvm 可用（boxlite 微 VM）';

  async run(): Promise<DiagnoseCheckResult> {
    const os = platform();
    if (os !== 'linux') {
      return {
        status: 'info',
        summary: `当前系统是 ${os}，没有 /dev/kvm 这个设备 —— 微 VM 档位（boxlite）在此平台不适用`,
        detail: { platform: os },
      };
    }
    try {
      await access(KVM, constants.R_OK | constants.W_OK);
      return { status: 'ok', summary: '/dev/kvm 可读写，微 VM 档位（boxlite）就绪' };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // 两种失败的下一步完全不同：设备不在 ⇒ 宿主机没开虚拟化；在但没权限 ⇒ 加用户组。
      const missing = err.code === 'ENOENT';
      return {
        status: 'warn',
        summary: missing
          ? '/dev/kvm 不存在 —— 微 VM 档位（boxlite）不可用，容器档位（aio）不受影响'
          : `/dev/kvm 存在但当前进程无读写权限（${err.code ?? 'EACCES'}）—— 微 VM 档位不可用`,
        hint: missing
          ? '宿主机需开启硬件虚拟化（BIOS VT-x/AMD-V）并加载 kvm 模块：lsmod | grep kvm；云主机需选支持嵌套虚拟化的规格'
          : `把平台进程的运行用户加入 kvm 组：sudo usermod -aG kvm $(whoami) && ls -l ${KVM}`,
        detail: { path: KVM, errno: err.code ?? null },
      };
    }
  }
}
