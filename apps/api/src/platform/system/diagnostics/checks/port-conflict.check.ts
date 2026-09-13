import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { Injectable } from '@nestjs/common';
import { env } from '../../../config/env';
import type { DiagnoseCheck, DiagnoseCheckResult, DiagnoseContext } from './check.types';

/** 平台配置里真的会去监听的端口 + **它是拿来干什么的**。 */
interface WatchedPort {
  port: number;
  purpose: string;
}

/** 一个占用者。`command`/`pid` 任一拿不到时，这一项就退化成「知道被占、说不出被谁占」。 */
export interface PortHolder {
  pid: number;
  command: string;
}

/**
 * 诊断第 ④ 项：**端口占用**（P21-5 §9B，2026-08-28 修订）。
 *
 * ── 这一项的全部价值在于「被谁占了」──────────────────────────────────────────
 * ⚠️ 「端口 3000 被占用 ❌」这句话**没有任何可执行性** —— 用户下一步要做的是找出占它的
 * 东西，而那恰恰是诊断能直接答、他手动查却很费劲的部分。实证（2026-08-28 本机）：
 * 3000 被占，`lsof -nP -iTCP:3000 -sTCP:LISTEN` 报出 `com.docke`（Docker Desktop 的端口
 * 转发）—— **看到进程名的那一刻才判断出**是 Docker 里另一个应用占着，而不是平台自己起了
 * 两份。这两种情况的下一步完全不同（去关那个应用 / 去杀掉重复的平台进程）。
 *
 * ⇒ 本项必须带上三样：**端口号 · 占用它的进程名与 pid · 平台原本要用它做什么**。
 *
 * ── 两条不那么显然的规则 ────────────────────────────────────────────────────
 * ⚠️ **检查的是平台配置的端口实际取值（`PORT`），不是硬编码的 3000。** 用户改过配置
 * 之后，检查一个他没在用的端口只会制造假警报 —— 而假警报比不检查更贵。
 *
 * ⚠️ **占用者是平台自己时是 ✅，不是 ❌。** 诊断跑起来的时候平台正在监听那个端口，
 * 「有人在监听」本来就是常态。把自己算成冲突，会让每一次正常运行的诊断都报红 ——
 * 判据是 pid 等不等于本进程，不是「有没有人在监听」。
 */
@Injectable()
export class PortConflictCheck implements DiagnoseCheck {
  readonly id = 'port-conflict' as const;
  readonly label = '端口占用';

  private watched(): WatchedPort[] {
    return [
      {
        port: env.port,
        purpose: '平台 HTTP/WS 服务（REST · /events · /terminal · /tasks 同一端口）',
      },
    ];
  }

  async run(ctx: DiagnoseContext): Promise<DiagnoseCheckResult> {
    const conflicts: Array<{ port: WatchedPort; holders: PortHolder[] }> = [];
    const undetermined: WatchedPort[] = [];
    const self: WatchedPort[] = [];

    for (const p of this.watched()) {
      const holders = await listListeners(p.port, ctx);
      if (holders === null) {
        undetermined.push(p);
        continue;
      }
      const foreign = holders.filter((h) => h.pid !== process.pid);
      if (foreign.length === 0) {
        if (holders.length > 0) self.push(p);
        continue;
      }
      conflicts.push({ port: p, holders: foreign });
    }

    if (conflicts.length > 0) {
      const lines = conflicts.map(
        (c) =>
          `端口 ${String(c.port.port)}（${c.port.purpose}）被 ` +
          c.holders.map((h) => `${h.command} (pid ${String(h.pid)})`).join('、') +
          ' 占用',
      );
      return {
        status: 'fail',
        // ⚠️ headline 只回答「好不好 + 挡不挡我干活」。**被谁占**是这一项的全部价值，
        //    但它带着进程名与 pid，一行放不下 —— 下沉到 detailText，⛔ 不许丢掉。
        headline: `端口 ${String(conflicts[0]!.port.port)} 被占用，平台起不来`,
        detailText: `${lines.join('；')}。`,
        // ⚠️ 建议里给的是**查证**命令而不是 `kill`：占用者可能是用户正在用的另一个应用
        //    （实测那次就是 Docker Desktop），诊断没有资格替他决定杀掉它。
        nextStep:
          '先确认它是什么，确实该让路就停掉它；否则给平台换一个端口（PORT=<其它端口>）后重启平台。',
        command: `lsof -nP -iTCP:${String(conflicts[0]!.port.port)} -sTCP:LISTEN`,
        detail: {
          conflicts: conflicts.map((c) => ({
            port: c.port.port,
            purpose: c.port.purpose,
            holders: c.holders,
          })),
        },
      };
    }

    if (undetermined.length > 0) {
      // ⚠️ 「查不出来」不是「没被占」。最小化的容器镜像里既没有 lsof 也没有 ss，
      //    此时唯一诚实的结论是「这台机器上这一项查不了」。报 ✅ 会让一个真冲突
      //    在最需要它的部署形态里静默消失。
      return {
        status: 'warn',
        headline: '查不出端口有没有被占',
        detailText:
          `没能查证端口 ${undetermined.map((p) => String(p.port)).join('、')} 的占用情况` +
          '（本机没有 lsof / ss，或它们没有权限看到其它用户的进程）。' +
          '「查不出来」不等于「没被占」。',
        ...missingToolAdvice(platform()),
        detail: { ports: undetermined.map((p) => p.port), platform: platform() },
      };
    }

    const listed = this.watched()
      .map((p) => `${String(p.port)}（${p.purpose}）`)
      .join('、');
    return {
      status: 'ok',
      headline: '端口没有冲突',
      detailText:
        self.length > 0
          ? `端口 ${listed} 正由平台自己监听（pid ${String(process.pid)}）。`
          : `端口 ${listed} 未被占用。`,
      detail: { ports: this.watched(), selfPid: process.pid },
    };
  }
}

/**
 * 列出 LISTEN 在某端口上的进程。**`null` = 查不出来**（与「没人监听」是两件事）。
 *
 * 两条路径，按可得性依次尝试：
 *   · `lsof -F pcn` —— macOS 与多数 Linux 发行版都有，输出是逐行 `p<pid>` / `c<command>`；
 *   · `ss -ltnp`    —— 最小化 Linux 镜像里通常只有它（iproute2）。
 *
 * ⚠️ **`lsof` 在「没有匹配」时退出码是 1**，与「命令不存在」（ENOENT）不同 —— 混作一谈
 * 会让「端口空着」被报成「查不出来」，那是这一项最常见的一种情况。
 */
async function listListeners(port: number, ctx: DiagnoseContext): Promise<PortHolder[] | null> {
  const viaLsof = await run(
    'lsof',
    ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-F', 'pc'],
    ctx,
  );
  if (viaLsof.spawned) {
    return viaLsof.stdout.trim() === '' ? [] : parseLsof(viaLsof.stdout);
  }
  const viaSs = await run('ss', ['-ltnpH', `sport = :${String(port)}`], ctx);
  if (viaSs.spawned) {
    return viaSs.stdout.trim() === '' ? [] : parseSs(viaSs.stdout);
  }
  return null;
}

/** `-F pc` 的输出：每个进程一组，`p<pid>` 后面跟 `c<command>`。 */
export function parseLsof(stdout: string): PortHolder[] {
  const out: PortHolder[] = [];
  let pid: number | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) ? n : null;
    } else if (line.startsWith('c') && pid !== null) {
      out.push({ pid, command: line.slice(1) });
      pid = null;
    }
  }
  return out;
}

/** `ss -ltnpH` 的尾列：`users:(("node",pid=41235,fd=23))`。 */
export function parseSs(stdout: string): PortHolder[] {
  const out: PortHolder[] = [];
  for (const m of stdout.matchAll(/\(\("([^"]+)",pid=(\d+)/g)) {
    out.push({ command: m[1]!, pid: Number(m[2]) });
  }
  return out;
}

interface RunResult {
  /** 命令**跑起来了**（不管退出码）。`false` 专指 ENOENT/EACCES 那类「压根没这个命令」。 */
  spawned: boolean;
  stdout: string;
}

function run(cmd: string, args: string[], ctx: DiagnoseContext): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: Math.min(ctx.timeoutMs, 3000), signal: ctx.signal },
      (error, stdout) => {
        // ⚠️ 三种「error」要分开，混一起会把两种情况说成第三种：
        //   · ENOENT      —— 命令不存在 ⇒ 换下一条路径（最小化镜像里没有 lsof）
        //   · killed/超时 —— **查不出来**，绝不能当成「端口空着」
        //   · 退出码非 0  —— 命令跑完了，`lsof` 无匹配就是退出码 1 ⇒ stdout 空就是答案
        const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        if (err && (err.code === 'ENOENT' || err.killed === true)) {
          resolve({ spawned: false, stdout: '' });
          return;
        }
        resolve({ spawned: true, stdout });
      },
    );
  });
}

/**
 * 「装个工具这一项才查得了」—— **必须按平台分岔**（2026-09-11 修）。
 *
 * ⛔ 上一版无条件给 `apt-get install -y lsof`。macOS 上那条命令**执行不了**（没有 apt），
 * 而 macOS 恰恰是本平台默认档的宿主之一 —— 一条执行不了的命令比不给命令更贵，
 * 与 `connectivity.probe.ts#hintFor` 记的是同一条纪律。
 *
 * ⚠️ mac 自带 `lsof`，走到这里说明它**存在但看不到别的用户的进程** ⇒ 该说的是权限，
 * 不是安装。⛔ 别给一条它已经有的东西的安装命令。
 */
export function missingToolAdvice(os: string): { nextStep: string; command?: string } {
  if (os === 'darwin') {
    // ⛔ 不给 `sudo` 命令：让用户用管理员权限重跑一次平台，与教他 sudo 一条查询命令
    //    是两件事，后者查完了平台自己还是查不到。
    return {
      nextStep:
        '这台机器自带 lsof，查不到多半是权限不够 —— 用能看到其它用户进程的账号重启平台后再诊断。',
    };
  }
  if (os === 'linux') {
    return {
      nextStep: '装上 lsof（或 iproute2 里的 ss）之后这一项就能给出结论。',
      command: 'apt-get install -y lsof',
    };
  }
  // ⚠️ 认不出的平台**不编一条安装命令**：包管理器叫什么我们不知道。
  return { nextStep: '在这台机器上装一个能列出监听端口的工具（lsof 或 ss）之后重跑诊断。' };
}
