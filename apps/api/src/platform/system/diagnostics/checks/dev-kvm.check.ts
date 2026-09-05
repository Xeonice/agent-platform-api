import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';
import { SANDBOX_PROVIDER_REGISTRY } from '@platform/contracts';
import type { ProviderRegistry } from '@platform/contracts';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';
import { defaultSubstrate } from './substrate';

/** Linux 上 KVM 的设备节点。**这是 Linux 专有的东西**，别的平台上永远不会有。 */
const KVM = '/dev/kvm';
/** macOS 的虚拟化框架。系统自带，不需要安装任何东西。 */
const HV_FRAMEWORK = '/System/Library/Frameworks/Hypervisor.framework';
/**
 * boxlite 要 macOS 12+，而 macOS 12 = **Darwin 21**。
 *
 * ⚠️ 判的是 Darwin 主版本，**不做「Darwin − 9 = macOS」那个映射**：那个偏移在 macOS 26
 * （Darwin 25）上已经断了，写一张映射表只会在下一个大版本再错一次。而「Darwin 主版本
 * 单调递增」是稳的，`>= 21` 就是「macOS 12 或更新」的充要条件。
 */
const MIN_DARWIN_MAJOR = 21;

/**
 * 诊断第 ② 项：**微 VM 档位（boxlite）可用**。
 *
 * ── 它修的是什么：在 boxlite 唯一默认启用的平台上报「不适用」 ────────────────
 * 上一版这里写的是「`os !== 'linux'` ⇒ ℹ️ 当前系统是 darwin，没有 /dev/kvm 这个设备 ——
 * 微 VM 档位（boxlite）在此平台不适用」。**每一个词单独看都对，合起来的结论是反的**：
 *
 *   · `/dev/kvm` 确实是 Linux 专有的设备节点，macOS 上确实永远不会有；
 *   · 但 boxlite 在 macOS 上走的是 **Hypervisor.framework**（系统自带、无需 Docker、
 *     无需守护进程，官方原话 "no root, no background service"）；
 *   · 而 `hostPreferredProvider()` 是 `darwin ? 'boxlite' : 'aio'` —— **mac 上 boxlite
 *     不但适用，还是默认档**。
 *
 * ⇒ 这条检查把「Linux 上的实现细节」当成了「boxlite 的通用前置」。2026-09-05 本机实测：
 * `@boxlite-ai/boxlite-darwin-arm64` 已装、`JsBoxlite` 可实例化，第一次实例化失败的原因
 * 是 **`Failed to acquire runtime lock at ~/.boxlite`** —— 锁被**正在运行的后端服务**持有，
 * 也就是说 boxlite 此刻就在这台 mac 上跑着，而诊断在说它「不适用」。
 *
 * ── 落地：按平台问对的问题 ──────────────────────────────────────────────────
 *   · **darwin** ⇒ Hypervisor.framework / Apple Silicon / macOS 12+（`microVmPlan`
 *     + `darwinMicroVmVerdict`）
 *   · **linux**  ⇒ `/dev/kvm` 可读写（`linuxKvmVerdict`，与上一版口径一致）
 *   · 其余平台  ⇒ 如实说 boxlite 不支持，**不说「没有 /dev/kvm」**（那是在解释一件
 *     与结论无关的事）
 *
 * ⚠️ **判断与测量分开成纯函数**，与第 ⑦ 项 `reflinkStrategy` 同一个理由：CI 是 Linux、
 * 开发机是 macOS，只测「当前平台那一支」等于两边各测一半 —— 另一支的行为没有任何人守。
 *
 * ⚠️ **Linux 分支的严重度维持 ⚠️，本轮刻意没动。** 严格按「谁需要它」判，一台默认跑 aio
 * 的 Linux 机器上没有 `/dev/kvm` 应当是 ℹ️ 而不是 ⚠️（这一项因此在绝大多数 Linux 部署上
 * 是个恒 ⚠️ 的噪音项）。那是**另一条同型误判**，单独记在报告里，不夹带进这次修复。
 */
@Injectable()
export class DevKvmCheck implements DiagnoseCheck {
  readonly id = 'dev-kvm' as const;
  /**
   * ⚠️ **label 不再叫 `/dev/kvm 可用`。** 在一台报 ✅ 的 mac 上，一个写着「/dev/kvm 可用」
   * 的标题和一句「Hypervisor.framework 就绪」的正文自相矛盾 —— 而用户先读到的是标题。
   * id 是跨仓契约的闭集（`DIAGNOSE_CHECK_IDS` + `SSE_PROTOCOL_CANONICAL`），**不动**；
   * label 只是展示文案，帧里逐项下发，改它不碰任何契约。
   */
  readonly label = '微 VM 档位（boxlite）可用';

  constructor(@Inject(SANDBOX_PROVIDER_REGISTRY) private readonly providers: ProviderRegistry) {}

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const os = platform();
    const plan = microVmPlan(os);
    const isDefault = defaultSubstrate(this.providers).substrate === 'micro-vm';

    if (plan.kind === 'unsupported') {
      return {
        status: 'info',
        summary: `${plan.reason} —— 这台机器用容器档位（aio）`,
        detail: { platform: os, arch: arch() },
      };
    }
    if (plan.kind === 'hypervisor-framework') {
      return darwinMicroVmVerdict(
        {
          arch: arch(),
          darwinRelease: release(),
          hvSupport: await hvSupport(ctx),
          frameworkPresent: await exists(HV_FRAMEWORK),
        },
        isDefault,
      );
    }
    return linuxKvmVerdict(await errnoOf(KVM), isDefault);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判断（纯函数）—— 两条平台分支都能在任意一台机器上被断言
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 这个平台上，「微 VM 档位能不能用」该问**哪个**问题。
 *
 * ⛔ **`/dev/kvm` 不是这个问题的通用形式**，它只是 Linux 上的那个形式。上一版把两者
 * 混为一谈，于是 macOS 掉进了「没有这个设备 ⇒ 不适用」——而 macOS 恰恰是 boxlite
 * 唯一默认启用的平台。
 */
export function microVmPlan(
  os: string,
):
  | { kind: 'kvm-device' }
  | { kind: 'hypervisor-framework' }
  | { kind: 'unsupported'; reason: string } {
  if (os === 'linux') return { kind: 'kvm-device' };
  if (os === 'darwin') return { kind: 'hypervisor-framework' };
  return {
    kind: 'unsupported',
    reason: `boxlite 只支持 Linux（KVM）与 macOS（Hypervisor.framework），当前系统是 ${os}`,
  };
}

/** darwin 上决定结论的四个事实。`hvSupport` 为 `null` = **问不出来**，不是「不支持」。 */
export interface DarwinMicroVmFacts {
  /** `os.arch()`。Apple Silicon 是 `arm64`；Intel（`x64`）官方标注 coming soon。 */
  arch: string;
  /** `os.release()`，形如 `25.5.0`。 */
  darwinRelease: string;
  /** `sysctl -n kern.hv_support`：内核自己回答「本机支不支持 Hypervisor.framework」。 */
  hvSupport: boolean | null;
  /** `/System/Library/Frameworks/Hypervisor.framework` 在不在。 */
  frameworkPresent: boolean;
}

/**
 * darwin 的结论。
 *
 * ⚠️ **分支顺序 = 用户要修的东西的顺序。** 一台 Intel mac 既不是 arm64、`kern.hv_support`
 * 也可能是 1，先报哪个决定了他下一步做什么 —— 换机器这件事没法靠改配置绕过去，所以它排第一。
 *
 * ⚠️ **`hvSupport === null` 不阻止 ✅。** 官方列出的前置是「macOS 12+ · Apple Silicon」，
 * `kern.hv_support` 是额外的佐证而不是前置；问不出来时如实记进 `detail`，但不拿它判坏。
 *
 * ⚠️ 拦下时是 ⚠️ 而不是 ❌：这台机器仍有一条能走的路（容器档 aio + Docker Desktop），
 * hint 必须把那条路说出来 —— 「说错下一步比不说更贵」，而「没有下一步」同样贵。
 */
export function darwinMicroVmVerdict(
  f: DarwinMicroVmFacts,
  isDefaultProvider: boolean,
): DiagnoseCheckResult {
  const major = Number(f.darwinRelease.split('.')[0]);
  const detail = {
    platform: 'darwin',
    arch: f.arch,
    darwinRelease: f.darwinRelease,
    darwinMajor: Number.isInteger(major) ? major : null,
    hvSupport: f.hvSupport,
    hypervisorFramework: f.frameworkPresent ? HV_FRAMEWORK : null,
  };
  const fallback =
    '要在这台机器上跑任务，改用容器档位（aio）：装 Docker Desktop 后重启平台，' +
    '并在新建任务时显式选 aio';

  if (f.arch !== 'arm64') {
    return {
      status: 'warn',
      summary: `这台 Mac 是 ${f.arch}（非 Apple Silicon）—— boxlite 目前只支持 Apple Silicon，Intel 官方标注 coming soon`,
      hint: fallback,
      detail,
    };
  }
  if (!Number.isInteger(major) || major < MIN_DARWIN_MAJOR) {
    return {
      status: 'warn',
      summary: `系统版本过低（Darwin ${f.darwinRelease}）—— boxlite 要 macOS 12 或更新（Darwin ${String(MIN_DARWIN_MAJOR)}+）`,
      hint: `升级 macOS 到 12 及以上；或${fallback}`,
      detail,
    };
  }
  if (f.hvSupport === false) {
    return {
      status: 'warn',
      summary:
        '内核报告 kern.hv_support=0 —— 这台机器上拿不到硬件虚拟化，Hypervisor.framework 用不了（常见于跑在虚拟机里的 macOS）',
      hint: `在物理机上运行平台；跑在虚拟机里则要宿主放开嵌套虚拟化。或${fallback}`,
      detail,
    };
  }
  if (!f.frameworkPresent) {
    return {
      status: 'warn',
      summary: `${HV_FRAMEWORK} 不在 —— 这在正常的 macOS 上不该发生，微 VM 档位（boxlite）用不了`,
      hint: `确认系统完整性（这是系统自带框架，不由平台安装）。或${fallback}`,
      detail,
    };
  }
  return {
    status: 'ok',
    summary:
      `Hypervisor.framework 就绪（Apple Silicon · Darwin ${f.darwinRelease}${f.hvSupport === true ? ' · kern.hv_support=1' : ''}）` +
      ` —— 微 VM 档位（boxlite）可用${isDefaultProvider ? '，且是这台机器的默认档' : ''}` +
      '。⛔ 它不需要 Docker，也不需要任何守护进程',
    detail,
  };
}

/**
 * linux 的结论。参数是 `access(/dev/kvm, R|W)` 的 errno，`null` = 可读写。
 *
 * ⚠️ 两种失败的下一步完全不同：设备不在 ⇒ 宿主机没开虚拟化；在但没权限 ⇒ 加用户组。
 *
 * ── ⛔ 严重程度按「谁需要它」分岔（2026-09-05 补齐 §9F 的判据总纲）─────────────
 * 上一版**无条件 warn**：一台默认跑容器档（aio）的 Linux 机器，只因为没有 `/dev/kvm`
 * 就常年顶着一个 ⚠️ —— 而它**完全健康**，那条路它根本不走。
 *
 * ⛔ 这正是本项自己那条纪律的反面：**无条件要求某个依赖在，与恒 ⚠️ 的噪音项是同一种
 * 失败**（P21-5 §9D/§9F）。一个永远黄着的格子看久了没人看，还会把其余七项的可信度
 * 一起拉低。darwin 那一支 2026-09-05 已经收了 `isDefaultProvider`，**Linux 这支当时漏了**。
 *
 * ⇒ 默认档是微 VM ⇒ ⚠️（它挡住了这台机器实际要走的路）；不是 ⇒ ℹ️「当前默认档不需要它」。
 */
export function linuxKvmVerdict(
  errno: string | null,
  isDefaultProvider: boolean,
): DiagnoseCheckResult {
  if (errno === null) {
    return {
      status: 'ok',
      summary:
        '/dev/kvm 可读写 —— 微 VM 档位（boxlite）可用' +
        (isDefaultProvider ? '，且是这台机器的默认档' : ''),
      detail: { platform: 'linux', path: KVM, errno: null, isDefaultProvider },
    };
  }
  const missing = errno === 'ENOENT';
  const what = missing ? '/dev/kvm 不存在' : `/dev/kvm 存在但当前进程无读写权限（${errno}）`;

  if (!isDefaultProvider) {
    // ℹ️ 不是 ⚠️：这台机器的默认档不走微 VM，缺它什么都不耽误。
    return {
      status: 'info',
      summary: `${what} —— 微 VM 档位（boxlite）不可用，但**当前默认档不需要它**（走容器档 aio）`,
      detail: { platform: 'linux', path: KVM, errno, isDefaultProvider: false },
    };
  }
  return {
    status: 'warn',
    summary: `${what} —— 微 VM 档位（boxlite）不可用，而它正是这台机器的默认档`,
    hint: missing
      ? '宿主机需开启硬件虚拟化（BIOS VT-x/AMD-V）并加载 kvm 模块：lsmod | grep kvm；云主机需选支持嵌套虚拟化的规格'
      : `把平台进程的运行用户加入 kvm 组：sudo usermod -aG kvm $(whoami) && ls -l ${KVM}`,
    detail: { platform: 'linux', path: KVM, errno, isDefaultProvider: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 测量
// ─────────────────────────────────────────────────────────────────────────────

/** `access(path, R|W)` 的 errno，`null` = 可读写。 */
async function errnoOf(path: string): Promise<string | null> {
  try {
    await access(path, constants.R_OK | constants.W_OK);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? 'EACCES';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `sysctl -n kern.hv_support` —— 内核自己回答「本机支不支持 Hypervisor.framework」。
 *
 * ⚠️ **问不出来回 `null`，不回 `false`。** 与 `MeasuredMemory` 的 `unmeasurable`
 * 同一条纪律：一个测不准的读数绝不该把一台好机器判成坏的。
 */
function hvSupport(ctx: DiagnoseContext): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile(
      'sysctl',
      ['-n', 'kern.hv_support'],
      { timeout: Math.min(ctx.timeoutMs, 3000), signal: ctx.signal },
      (error, stdout) => resolve(error ? null : stdout.trim() === '1'),
    );
  });
}
