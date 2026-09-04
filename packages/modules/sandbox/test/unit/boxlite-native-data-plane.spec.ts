import { describe, it, expect } from 'vitest';
import type { ProcessStream, SandboxHandle } from '@platform/contracts';
import { SandboxProviderError, TaskArtifactSchema } from '@platform/contracts';
import type {
  BoxliteExecution,
  ExecCapableBox,
} from '../../src/infrastructure/providers/boxlite/boxlite-runtime';
import { spawnNative } from '../../src/infrastructure/providers/boxlite/boxlite-process.stream';
import { BoxliteSandboxFiles } from '../../src/infrastructure/providers/boxlite/boxlite-files';
import { BoxliteSandboxJobs } from '../../src/infrastructure/providers/boxlite/boxlite-jobs';
import { BoxliteSandboxProvider } from '../../src/infrastructure/providers/boxlite/boxlite-sandbox.provider';

/**
 * boxlite **native 数据面**的离线用例（决策 A 修订）。
 *
 * ── 为什么这些能离线跑，以及为什么值得离线跑 ────────────────────────────────
 * 数据面全部收在 `ExecCapableBox`（只有 `exec` 一个方法）后面，所以整条链——
 * `spawn` 的字段映射、文件面的 base64 通道、作业面那几段 guest 脚本——都能用一个
 * 替身在**没有 hypervisor 的机器上**（CI 就是）跑完。真沙箱那半在 e2e 的 DP-\* 条款里。
 *
 * ⚠️ 这里断言的每一条「脚本长什么样」都不是形式主义：它们逐条对应一次**实测踩过的
 * 坑**，注释里写了是哪一次。改脚本时如果这些红了，先去看注释说的那个坑还在不在。
 */

interface Call {
  command: string;
  args: string[];
  env: [string, string][] | null;
  tty: boolean;
  user: string | null;
  timeoutSecs: number | null;
  cwd: string | null;
  stdin: string;
}

interface Reply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** 一次 `JsExecution` 的替身：立即结束，回放脚本给定的输出与退出码。 */
class FakeExecution implements BoxliteExecution {
  stdinChunks: string[] = [];
  stdinClosed = false;
  private writeSeq = 0;
  signals: number[] = [];
  resizes: [number, number][] = [];
  killed = false;
  private released: (() => void)[] = [];

  constructor(
    private readonly reply: Reply,
    /** `undefined` ⇒ 立即结束；给了就要等它被调用（模拟长跑进程）。 */
    private readonly manual = false,
  ) {}

  private done = false;

  finish(): void {
    this.done = true;
    for (const r of this.released.splice(0)) r();
  }

  private async ready(): Promise<void> {
    if (!this.manual || this.done) return;
    await new Promise<void>((r) => this.released.push(r));
  }

  id(): Promise<string> {
    return Promise.resolve('fake');
  }

  stdin(): Promise<{
    write(d: Buffer): Promise<void>;
    writeString(t: string): Promise<void>;
    close(): Promise<void>;
  }> {
    return Promise.resolve({
      write: (d: Buffer) => {
        this.stdinChunks.push(d.toString('utf8'));
        return Promise.resolve();
      },
      /**
       * ⚠️ **故意让先发的写更慢**（30ms / 15ms / 0ms）。
       *
       * 这不是装饰：`ProcessStream.write` 是同步返回的，而 native 的 `writeString`
       * 是 Promise —— 如果实现不把写串成一条链，两次快速击键就会**乱序**落进 tty。
       * 用一个瞬时完成的替身根本量不出这件事（微任务顺序恰好把它掩盖掉），于是
       * 「去掉串行链」这个变异会假绿。倒序的延迟让乱序变成可观察的。
       */
      writeString: async (t: string) => {
        await new Promise((r) => setTimeout(r, Math.max(0, 30 - this.writeSeq++ * 15)));
        this.stdinChunks.push(t);
      },
      close: () => {
        this.stdinClosed = true;
        return Promise.resolve();
      },
    });
  }

  stdout(): Promise<{ next(): Promise<string | null> }> {
    return Promise.resolve(this.oneShot(this.reply.stdout));
  }

  stderr(): Promise<{ next(): Promise<string | null> }> {
    return Promise.resolve(this.oneShot(this.reply.stderr));
  }

  private oneShot(text?: string): { next(): Promise<string | null> } {
    let sent = false;
    return {
      next: async () => {
        await this.ready();
        if (sent || text === undefined || text === '') return null;
        sent = true;
        return text;
      },
    };
  }

  async wait(): Promise<{ exitCode: number; errorMessage?: string }> {
    await this.ready();
    return { exitCode: this.reply.code ?? 0 };
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.finish();
  }

  resizeTty(rows: number, cols: number): Promise<void> {
    this.resizes.push([rows, cols]);
    return Promise.resolve();
  }

  signal(signal: number): Promise<void> {
    this.signals.push(signal);
    this.finish();
    return Promise.resolve();
  }
}

class FakeBox implements ExecCapableBox {
  readonly calls: Call[] = [];
  readonly executions: FakeExecution[] = [];

  constructor(
    private readonly reply: (call: Call) => Reply = () => ({}),
    private readonly manual = false,
  ) {}

  async exec(
    command: string,
    args?: string[] | null,
    env?: [string, string][] | null,
    tty?: boolean | null,
    user?: string | null,
    timeoutSecs?: number | null,
    workingDir?: string | null,
  ): Promise<BoxliteExecution> {
    const call: Call = {
      command,
      args: args ?? [],
      env: env ?? null,
      tty: tty ?? false,
      user: user ?? null,
      timeoutSecs: timeoutSecs ?? null,
      cwd: workingDir ?? null,
      stdin: '',
    };
    this.calls.push(call);
    const execution = new FakeExecution(this.reply(call), this.manual);
    this.executions.push(execution);
    // stdin 是异步喂进来的，测试要在断言时看到它 —— 把它回填进 call。
    queueMicrotask(() => {
      Object.defineProperty(call, 'stdin', {
        get: () => execution.stdinChunks.join(''),
        configurable: true,
      });
    });
    return execution;
  }
}

const HANDLE: SandboxHandle = { provider: 'boxlite', providerSandboxId: 'box-1' };
const boxFor = (box: ExecCapableBox) => () => Promise.resolve(box);

function collect(stream: ProcessStream): Promise<{ out: string; code: number | null }> {
  return new Promise((res) => {
    let out = '';
    stream.onData((c) => {
      out += c.toString('utf8');
    });
    stream.onExit((code) => res({ out, code }));
  });
}

describe('boxlite spawn(tty:false) — 每个 ProcessSpec 字段都是 native 原生参数', () => {
  it('argv / env / cwd / user / timeoutMs 全部原样落到 box.exec 的对应形参上', async () => {
    const box = new FakeBox(() => ({ stdout: 'hi\n', code: 0 }));
    const stream = await spawnNative(box, {
      cmd: ['sh', '-c', 'echo hi'],
      tty: false,
      env: { A: '1' },
      cwd: '/etc',
      user: 'root',
      timeoutMs: 2500,
    });
    const r = await collect(stream);
    const call = box.calls[0];
    expect(call.command).toBe('sh');
    expect(call.args).toEqual(['-c', 'echo hi']);
    expect(call.env).toEqual([['A', '1']]);
    expect(call.cwd).toBe('/etc');
    // `user` 在 aio 侧是 UNSUPPORTED_CAPABILITY，在 native 侧是真参数。
    expect(call.user).toBe('root');
    // 秒，向上取整：2500ms ⇒ 3s，宁可多给也不能少给（少给 = 提前杀）。
    expect(call.timeoutSecs).toBe(3);
    expect(call.tty).toBe(false);
    expect(r.out).toBe('hi\n');
    expect(r.code).toBe(0);
  });

  it('stdin 经真 fd 0 投喂并**总是**关闭 —— 没有 payload 时也关', async () => {
    const withPayload = new FakeBox();
    await collect(await spawnNative(withPayload, { cmd: ['cat'], tty: false, stdin: 'SECRET' }));
    expect(withPayload.executions[0].stdinChunks.join('')).toBe('SECRET');
    expect(withPayload.executions[0].stdinClosed).toBe(true);
    // payload 只走 stdin，argv 里连影子都没有（05 §7 #3）。
    expect(JSON.stringify(withPayload.calls[0].args)).not.toContain('SECRET');

    // ⚠️ 不关的话 fd 0 是一根永不 EOF 的管道，`cat` 这类命令会在沙箱里挂死。
    const noPayload = new FakeBox();
    await collect(await spawnNative(noPayload, { cmd: ['cat'], tty: false }));
    expect(noPayload.executions[0].stdinClosed).toBe(true);
  });

  it('信号杀死原样透传负退出码；到点超时才归一成 124', async () => {
    // native 对「被 SIGTERM 杀」和「到点被 timeoutSecs 杀」报的是**同一个** -15，
    // 所以 124 只能由平台侧那个计时器标志决定 —— 这条钉的就是这个区分。
    const plain = new FakeBox(() => ({ code: -15 }));
    expect((await collect(await spawnNative(plain, { cmd: ['x'], tty: false }))).code).toBe(-15);

    const timedOut = new FakeBox(() => ({ code: -15 }), true);
    const stream = await spawnNative(timedOut, { cmd: ['x'], tty: false, timeoutMs: 10 });
    const settled = collect(stream);
    await new Promise((r) => setTimeout(r, 40));
    timedOut.executions[0].finish();
    expect((await settled).code).toBe(124);
  });

  it('空 cmd 立刻抛，而不是让 box.exec 拿到 undefined', async () => {
    await expect(spawnNative(new FakeBox(), { cmd: [], tty: false })).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
  });

  it('迟到注册的 onData 也拿得到完整输出（与 AioExecProcessStream 同语义）', async () => {
    const box = new FakeBox(() => ({ stdout: 'late\n' }));
    const stream = await spawnNative(box, { cmd: ['x'], tty: false });
    await new Promise((r) => setTimeout(r, 20));
    let seen = '';
    stream.onData((c) => {
      seen += c.toString('utf8');
    });
    expect(seen).toBe('late\n');
  });

  it('detach 只松手：不发信号、不合成 exit，且此后注册的回调也不再被喂', async () => {
    const box = new FakeBox(() => ({ stdout: 'after-detach', code: 0 }), true);
    const stream = await spawnNative(box, { cmd: ['x'], tty: false });
    let exits = 0;
    stream.onExit(() => (exits += 1));
    stream.detach();

    box.executions[0].finish();
    await new Promise((r) => setTimeout(r, 30));
    expect(exits).toBe(0);

    // ⚠️ **晚注册必须放在进程已经 settle 之后**——第一版把它放在 settle 之前，结果
    // 「去掉 detach 守卫」这个变异**假绿**：那时 `exited` 还是 false，`onExit` 的
    // 补发分支根本没被执行到，断言测的是一条没跑到的代码。现在 `exited` 已为真，
    // 守卫一旦拿掉，`if (this.exited) cb(...)` 会立刻给一个**已经松手**的调用方补发
    // 一次「进程已退出」——那正是要挡的。
    let lateExits = 0;
    let lateData = 0;
    stream.onExit(() => (lateExits += 1));
    stream.onData(() => (lateData += 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(lateExits).toBe(0);
    expect(lateData).toBe(0);
    // 「不碰对面进程」：一个信号都没发过，也没 kill。
    expect(box.executions[0].signals).toEqual([]);
    expect(box.executions[0].killed).toBe(false);
  });

  it('kill 两阶段：先 SIGTERM，宽限窗内没停再 SIGKILL', async () => {
    const box = new FakeBox(() => ({ code: -15 }), true);
    const stream = await spawnNative(box, { cmd: ['sleep'], tty: false });
    await stream.kill();
    // FakeExecution 收到 signal(15) 就结束 ⇒ 不该升级到 9。
    expect(box.executions[0].signals).toEqual([15]);
  });
});

describe('boxlite spawn(tty:true) — 真 PTY', () => {
  it('tty=true、补默认 TERM、cmd 为空时起默认 shell', async () => {
    const box = new FakeBox(undefined, true);
    await spawnNative(box, { cmd: [], tty: true, cols: 100, rows: 30 });
    const call = box.calls[0];
    expect(call.tty).toBe(true);
    expect(call.command).toBe('/bin/bash');
    // ⚠️ 不给 TERM 的话 guest 里 `tput cols` 直接报 "No value for $TERM"（实测），
    // xterm.js 那侧的重绘/颜色全建立在它上面。
    expect(call.env).toContainEqual(['TERM', 'xterm-256color']);
  });

  it('调用方自己的 TERM 赢过默认值', async () => {
    const box = new FakeBox(undefined, true);
    await spawnNative(box, { cmd: ['/bin/sh'], tty: true, env: { TERM: 'dumb' } });
    expect(box.calls[0].env).toContainEqual(['TERM', 'dumb']);
    expect(box.calls[0].env).not.toContainEqual(['TERM', 'xterm-256color']);
  });

  it('resize(cols, rows) → resizeTty(rows, cols) —— 参数序是反的', async () => {
    const box = new FakeBox(undefined, true);
    const stream = await spawnNative(box, { cmd: ['/bin/sh'], tty: true, cols: 100, rows: 30 });
    stream.resize(120, 40);
    await new Promise((r) => setTimeout(r, 10));
    // 第一次来自 spawn 的初始窗口（cols=100,rows=30），第二次来自显式 resize。
    expect(box.executions[0].resizes).toEqual([
      [30, 100],
      [40, 120],
    ]);
  });

  it('write 按调用顺序串行落进 stdin', async () => {
    const box = new FakeBox(undefined, true);
    const stream = await spawnNative(box, { cmd: ['/bin/sh'], tty: true });
    stream.write('a');
    stream.write('b');
    stream.write('c');
    // 替身给先发的写更长的延迟（30/15/0ms），所以要等够 —— 等待本身不削弱断言：
    // 顺序错了等多久都还是错的。
    await new Promise((r) => setTimeout(r, 300));
    expect(box.executions[0].stdinChunks.join('')).toBe('abc');
  });

  it('kill(SIGINT) 只投 SIGINT（中断前台命令、留下 shell），不升级', async () => {
    const box = new FakeBox(undefined, true);
    const stream = await spawnNative(box, { cmd: ['/bin/sh'], tty: true });
    await stream.kill('SIGINT');
    expect(box.executions[0].signals).toEqual([2]);
  });
});

describe('boxlite 文件面 —— exec + base64（不是 copyIn/copyOut）', () => {
  const files = (box: ExecCapableBox) => new BoxliteSandboxFiles('boxlite', boxFor(box));
  const BINARY = Buffer.from([0x00, 0x01, 0xa3, 0xff, 0x0a, 0x41, 0xc3, 0x28]);

  it('readFile 二进制精确；缺文件回 null 而不是抛', async () => {
    const ok = new FakeBox(() => ({ stdout: BINARY.toString('base64'), code: 0 }));
    expect((await files(ok).readFile(HANDLE, '/workspace/a.bin'))?.equals(BINARY)).toBe(true);
    // 路径走**位置参数**，脚本文本里没有它 —— 名字里带空格/引号也不会出事。
    expect(ok.calls[0].args).toContain('/workspace/a.bin');

    const missing = new FakeBox(() => ({ code: 66 }));
    expect(await files(missing).readFile(HANDLE, '/workspace/nope')).toBeNull();
    expect(await files(missing).openFileStream(HANDLE, '/workspace/nope')).toBeNull();
  });

  it('writeFile 把内容放进 stdin，argv 里只有路径', async () => {
    const box = new FakeBox(() => ({ code: 0 }));
    await files(box).writeFile(HANDLE, '/workspace/deep/s.bin', BINARY);
    const call = box.calls[0];
    expect(box.executions[0].stdinChunks.join('')).toBe(BINARY.toString('base64'));
    expect(JSON.stringify(call.args)).not.toContain(BINARY.toString('base64'));
    // 契约要求「缺失的父目录自动创建」（aio 的 agent 就是这么做的）。
    expect(call.args.join(' ')).toContain('mkdir -p');
  });

  it('listFiles 解析 NUL 分隔的 find 行：目录 size 缺席、名字里的空格与制表符不串行', async () => {
    // `we ird.txt` 是实测过的真名字；`tab\tname` 钉住「只切前三个 tab」这条。
    const rows =
      ['f', '12', '1787749003.87', '/w/we ird.txt'].join('\t') +
      '\0' +
      ['f', '3', '1787749003.87', '/w/tab\tname'].join('\t') +
      '\0' +
      ['d', '96', '1787749003.87', '/w/sub'].join('\t') +
      '\0';
    const box = new FakeBox(() => ({ stdout: rows, code: 0 }));
    const entries = await files(box).listFiles(HANDLE, '/w');
    expect(entries.map((e) => e.path)).toEqual(['/w/we ird.txt', '/w/tab\tname', '/w/sub']);
    expect(entries[0].size).toBe(12);
    expect(entries[2].kind).toBe('dir');
    // 目录的 size 必须**缺席**而不是 0 —— aio 的 agent 对目录报 `size: null`，
    // 两边形状不一致的话同一段应用代码会看到不同的 JSON。
    expect(entries[2].size).toBeUndefined();
    expect(entries[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('目录不存在时 listFiles 回空数组（「任务没产出」是正常结局，不是故障）', async () => {
    const box = new FakeBox(() => ({ code: 1, stderr: 'find: no such' }));
    expect(await files(box).listFiles(HANDLE, '/nope')).toEqual([]);
  });

  /**
   * ⛔ **这条断言是一个缺口的快照，不是一条期望。**
   *
   * `parseFindRow` 写的是 `epochSecondsToIso(mtime) ?? ''` —— `find -printf '%T@'`
   * 给不出可解析的 mtime 时，`FileEntry.modifiedAt`（→ 一路走到
   * `AgentTaskDto.artifacts[].modifiedAt`）出线的是**空串**。aio 那条路径同一行代码，
   * `agent-task.repository` 的 JSON 回读还有第三处同样的 `?? ''` 兜底。
   *
   * ⇒ 这就是 `TaskArtifactSchema.modifiedAt` **必须**留成裸 `z.string()`、不能跟着
   * 其它时刻字段收成 `IsoInstantSchema` 的全部理由（那边的注释指向这里）。
   * 契约声称「必是 ISO 瞬时」而实现随时能发 `''`，是把已知缺口伪装成保证。
   *
   * ⭐ **要真正修掉它，动的是产出侧而不是契约**：决定 `''` 该换成「该条目缺席」还是
   * 「`modifiedAt` 变 optional」——那是实现决策。改完之后这条用例会红，那时它就完成了
   * 使命：把 `expect('')` 换成新的期望，再去把契约收成 `IsoInstantSchema`。
   */
  it('⛔ mtime 不可解析时 modifiedAt 是空串 —— 契约里那个裸 string 的原因', async () => {
    // `%T@` 那一列是 `-`（find 在某些 fs 上对特殊文件就这么打），Number('-') = NaN。
    const rows = ['f', '12', '-', '/w/odd.txt'].join('\t') + '\0';
    const box = new FakeBox(() => ({ stdout: rows, code: 0 }));
    const entries = await files(box).listFiles(HANDLE, '/w');

    expect(entries).toHaveLength(1);
    expect(entries[0].modifiedAt).toBe('');
    // 而这个值今天是**合法出线值**：契约收紧的那一刻，出线的东西就违约了。
    expect(
      TaskArtifactSchema.safeParse({ name: 'odd.txt', size: 12, modifiedAt: '' }).success,
    ).toBe(true);
  });

  it('handle 不属于本 provider 时拒绝', async () => {
    await expect(
      files(new FakeBox()).readFile({ provider: 'aio', providerSandboxId: 'x' }, '/a'),
    ).rejects.toBeInstanceOf(SandboxProviderError);
  });
});

describe('boxlite 作业面 —— setsid + 文件 + 游标', () => {
  const jobs = (box: ExecCapableBox) => new BoxliteSandboxJobs('boxlite', boxFor(box));

  it('startJob：命令写进 runner 文件（不在 launcher argv），trap 是真处理器，timeout 兑现', async () => {
    const box = new FakeBox(() => ({ code: 0 }));
    const handle = await jobs(box).startJob(HANDLE, {
      cmd: ['codex', 'exec', '--json'],
      timeoutMs: 90_000,
      env: { K: 'V' },
      cwd: '/workspace',
    });
    const [setup, launch] = box.calls;
    const runner = box.executions[0].stdinChunks.join('');

    // ① 作业命令走 runner 文件（经 stdin），launcher 的 argv 里没有它。
    expect(runner).toContain(`'codex' 'exec' '--json'`);
    expect(JSON.stringify(launch.args)).not.toContain('codex');
    // ② setsid ⇒ 新 session，进程与这次 execution 解耦（实测：execution 结束后仍在跑）。
    expect(launch.args.join(' ')).toContain('setsid sh "$1/run.sh"');
    // ③ ⚠️ trap 必须是**真处理器**。实测踩过：写成 `trap '' TERM`（忽略）之后子进程
    //    继承 SIG_IGN，整个进程组变成杀不死；真处理器下子进程恢复默认处置。
    expect(runner).toMatch(/^trap '.+' INT TERM HUP$/m);
    expect(runner).not.toMatch(/trap ''/);
    expect(runner).toContain('143');
    // ④ timeout(1) 到点回 124 —— 正好是平台既有的超时口径，不用再翻译。
    expect(runner).toContain('timeout -k 5 90 ');
    // ⑤ env / cwd 经 native 形参交给 launcher，再由 setsid 继承下去；不进任何 shell 串。
    expect(launch.env).toEqual([['K', 'V']]);
    expect(launch.cwd).toBe('/workspace');
    // ⑥ setup 用 `mkdir -m 700`（无 -p 之外的松弛）落在 /var/tmp —— /tmp 是 tmpfs（实测）。
    expect(setup.args.join(' ')).toContain('mkdir -m 700');
    expect(handle.jobId).toContain('/var/tmp/.platform-job-');
  });

  it('startJob：镜像没有 timeout(1) ⇒ 当场 UNSUPPORTED_CAPABILITY，而不是收下再让它跑飞', async () => {
    const box = new FakeBox(() => ({ code: 67 }));
    await expect(jobs(box).startJob(HANDLE, { cmd: ['x'], timeoutMs: 1000 })).rejects.toMatchObject(
      { code: 'UNSUPPORTED_CAPABILITY' },
    );
  });

  it('startJob：stdin payload 走 stdin，只有目录进 argv', async () => {
    const box = new FakeBox(() => ({ code: 0 }));
    await jobs(box).startJob(HANDLE, { cmd: ['login'], stdin: 'TOKEN-XYZ' });
    const stdinCall = box.calls[1];
    expect(box.executions[1].stdinChunks.join('')).toBe(
      Buffer.from('TOKEN-XYZ', 'utf8').toString('base64'),
    );
    expect(JSON.stringify(stdinCall.args)).not.toContain('TOKEN-XYZ');
  });

  it('readJob：只交完整行，残尾留在游标后面；游标按字节推进', async () => {
    const chunk = 'a\nb\nhalf';
    const box = new FakeBox(() => ({
      stdout: `running\n${Buffer.from(chunk, 'utf8').toString('base64')}`,
      code: 0,
    }));
    const r = await jobs(box).readJob(HANDLE, {
      provider: 'boxlite',
      jobId: JSON.stringify({ d: '/var/tmp/.platform-job-abc' }),
    });
    expect(r.status).toBe('running');
    expect(r.stdout).toBe('a\nb\n');
    // 游标停在最后一个换行处 ⇒ 下一次 `tail -c +N` 从 'half' 开始，且**永远落在字符
    // 边界上**（0x0A 不可能出现在 UTF-8 多字节序列内部）。
    expect(JSON.parse(r.cursor).o).toBe(4);
    expect(r.exitCode).toBeUndefined();
  });

  it('readJob：作业结束时把残行也刷出来，并带上退出码', async () => {
    const box = new FakeBox(() => ({
      stdout: `124\n${Buffer.from('tail-no-newline', 'utf8').toString('base64')}`,
      code: 0,
    }));
    const r = await jobs(box).readJob(HANDLE, {
      provider: 'boxlite',
      jobId: JSON.stringify({ d: '/var/tmp/.platform-job-abc' }),
    });
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(124);
    expect(r.stdout).toBe('tail-no-newline');
  });

  it('readJob：进程组没了却没留下 exit 文件 ⇒ exited 且**没有**退出码', async () => {
    // 这是 SIGKILL 掉 runner 之后的形态。契约明写：被信号杀死的进程没有普通退出码，
    // 调用方按「非 0 退出」处理 —— 报一个编造的 0 会让失败看起来像成功。
    const box = new FakeBox(() => ({ stdout: 'gone\n', code: 0 }));
    const r = await jobs(box).readJob(HANDLE, {
      provider: 'boxlite',
      jobId: JSON.stringify({ d: '/var/tmp/.platform-job-abc' }),
    });
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBeUndefined();
  });

  it('readJob：作业目录没了 ⇒ 响亮 NOT_FOUND，而不是「空 chunk + 还在跑」', async () => {
    const box = new FakeBox(() => ({ code: 66 }));
    await expect(
      jobs(box).readJob(HANDLE, {
        provider: 'boxlite',
        jobId: JSON.stringify({ d: '/var/tmp/.platform-job-abc' }),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('killJob：往**进程组**投信号，且不是 dash 会拒收的 `kill -TERM -- -pgid` 写法', async () => {
    const box = new FakeBox(() => ({ stdout: '143', code: 0 }));
    await jobs(box).killJob(HANDLE, {
      provider: 'boxlite',
      jobId: JSON.stringify({ d: '/var/tmp/.platform-job-abc' }),
    });
    const script = box.calls[0].args.join(' ');
    // ⚠️ 实测：dash 的 kill 内建不认 `--`，会报 `kill: Illegal number: -`。
    expect(script).toContain('kill -"$sig" -"$p"');
    expect(script).not.toContain('kill -"$sig" -- -"$p"');
    expect(box.calls[0].args).toContain('TERM');
  });

  it('readJob 拒绝不是本 provider 铸的 jobId', async () => {
    await expect(
      jobs(new FakeBox()).readJob(HANDLE, { provider: 'boxlite', jobId: 'not-json' }),
    ).rejects.toBeInstanceOf(SandboxProviderError);
  });
});

describe('BoxliteSandboxProvider 的能力位与 provider 私有状态', () => {
  it('snapshot 仍是 false —— SDK 有快照 API，但契约上没有对应方法', () => {
    // 能力位与「平台的一条分支」一一对应：翻成 true 只会放行一个平台随后无法兑现的
    // `create({ require: { snapshot: true } })`。先加方法，再改这一位。
    expect(new BoxliteSandboxProvider().capabilities.snapshot).toBe(false);
  });

  it('headlessTask 与两个面同时存在（CAP-02 的两个方向）', () => {
    const p = new BoxliteSandboxProvider();
    expect(p.capabilities.headlessTask).toBe(true);
    expect(p.jobs).toBeDefined();
    expect(p.files).toBeDefined();
  });
});
