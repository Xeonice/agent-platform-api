import { describe, it, expect } from 'vitest';
import {
  RUNTIME_ID_RE,
  isTerminalShellId,
  WS_SCHEMA_HASH,
  WS_TASKS_SCHEMA_HASH,
  WS_PROTOCOL_CANONICAL,
  X_SCHEMA_HASH_HEADER,
} from '@platform/contracts';
import type {
  SandboxWsEvent,
  TaskClientFrame,
  TaskServerFrame,
  TerminalClientFrame,
  TerminalServerFrame,
  TerminalSessionKind,
} from '@platform/contracts';

/**
 * WS protocol handshake constant (docs/shared/14 §2.5). S1 pins WS_SCHEMA_HASH to
 * a shared literal that must byte-equal the frontend's hardcoded value so the
 * /terminal handshake actually agrees; the real codegen-hash toolchain is later.
 */
describe('WS protocol schema hash', () => {
  it('is the pinned cross-repo literal (must equal the frontend constant)', () => {
    // v1 → v2：多标签（06 §5）—— `session` 多了 `shellId?`，客户端多了
    //          `close_shell{shellId}`。
    // v2 → v3：刷新后恢复标签（06 §5.5）—— 服务端多了 `shells{shells}`。
    // v3 → v4：终端标签能选跑什么 CLI（06 §5.6）—— 握手多了 `kind=runtime` +
    //          `?runtimeId=`，清单元素从裸 id 变成 `{shellId, runtimeId?}`。
    // ⚠️ 每一次 bump 都是**必须**的，哪怕改动对老客户端是兼容的（多出的字段它会忽略、
    // 新帧它不认就丢）：hash 的职责就是回答"这份前端与这个后端说的是不是同一套帧"，
    // 不 bump 就等于让一个不认识 `shells` 的前端宣称自己认识 —— 而那个前端会把
    // 「刷新后恢复标签」整件事静默地做不到，界面上没有任何异常。
    expect(WS_SCHEMA_HASH).toBe('sb-terminal-v4');
    expect(X_SCHEMA_HASH_HEADER).toBe('x-schema-hash');
  });

  it('documents the canonical frame shapes it stands for', () => {
    expect(WS_PROTOCOL_CANONICAL).toContain('terminal.server:data{data}');
    expect(WS_PROTOCOL_CANONICAL).toContain('session{socketSessionKey,shellId?}');
  });

  it('carries all EIGHT /events variants, including the two starting-段 progress ones', () => {
    // 10 §7.4 / §7.6: the event union is 8 wide. BOTH progress events are separate from
    // `sandbox.status_changed` for the same reason — the sandbox status is CONSTANT at
    // `starting` while they fire (753s measured for a cold CLI install, 190529ms for a
    // cold image pull), so folding either in would emit "state changes" where no state
    // changed.
    const events = [
      'sandbox.created',
      'sandbox.status_changed',
      'sandbox.removed',
      'sandbox.waiting_input',
      'project.clone_progress',
      'runtime-auth.status_changed',
      'runtime.install_progress',
      'sandbox.instance_progress',
    ];
    for (const e of events) expect(WS_PROTOCOL_CANONICAL).toContain(e);
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'runtime.install_progress{sandboxId,runtime,status,versionDetected?,errorCode?}',
    );
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'sandbox.instance_progress{sandboxId,phase,imageStaged?}',
    );
  });

  it('the /terminal frame shapes and the hash move in LOCKSTEP (v4 = 多标签 + 恢复 + 选 CLI)', () => {
    // WS_SCHEMA_HASH gates the /terminal handshake only; adding an /events variant
    // must not break a frontend that pins the literal (14 §2.5). 反过来，改 /terminal
    // 的帧形状**必须**同时 bump —— 这一对断言钉在一起就是为了让"改了形状忘了 bump"
    // 在这里当场红，而那是唯一有人会想起通知另一个仓的时刻。
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'terminal.client:input{data},resize{cols,rows},ping,close_shell{shellId}|' +
        'terminal.server:data{data},exit{code},pong,session{socketSessionKey,shellId?},' +
        'shells{shells[shellId,runtimeId?]}',
    );
    expect(WS_SCHEMA_HASH).toBe('sb-terminal-v4');
  });

  /**
   * ⭐ `shells` 的**三态**（06 §5.5）。`null` 不是凑数的第三个值：
   *   · `[...]` 有这些（顺序 = tmux 创建顺序，前端据此编「终端 1..n」）
   *   · `[]`    确认没有
   *   · `null`  **问不出来**（tmux server 不在 / 沙箱不通）
   * ⛔ 把第三态折成 `[]` 就是把「不知道」说成「没有」—— 用户看到"你没有开过终端"，
   *   而真相可能是他有三个终端正跑着东西。
   */
  it('shells 帧能表达三态，`null` 与 `[]` 不是一回事', () => {
    const known: TerminalServerFrame = { type: 'shells', shells: [{ shellId: 'a'.repeat(32) }] };
    const none: TerminalServerFrame = { type: 'shells', shells: [] };
    const unknown: TerminalServerFrame = { type: 'shells', shells: null };
    expect(known.shells).toHaveLength(1);
    expect(none.shells).toEqual([]);
    expect(unknown.shells).toBeNull();
    // 用"不发这一帧"表示第三态是不行的：那与"还没答"在前端无从区分。
    expect(WS_PROTOCOL_CANONICAL).toContain('shells{shells[shellId,runtimeId?]}');
  });

  /**
   * `close_shell` 是全协议**唯一**能销毁一个 tmux 会话的帧，所以它的形状要单独钉。
   *
   * ⛔ 载荷必须是 `shellId`，不能退化成"关掉我这条连接对应的那个"：被 LRU 淘汰的
   * 标签没有连接（08 §5.2），而用户照样会点它的 [×] —— 少了这个载荷，那个 tmux 会话
   * 就成了界面上看不见、也再关不掉的孤儿。
   */
  it('close_shell 带 shellId，而不是"关掉我这条连接的那个"', () => {
    const frame: TerminalClientFrame = { type: 'close_shell', shellId: 'a'.repeat(32) };
    expect(frame.shellId).toHaveLength(32);
    expect(WS_PROTOCOL_CANONICAL).toContain('close_shell{shellId}');
  });

  /**
   * ⭐ 清单元素带 `runtimeId?`（06 §5.6）——**刷新之后标签名还能叫对**。
   *
   * ⚠️ 缺席 = 这是个**纯终端**标签（或者沙箱里的 tmux 老到读不出那个用户选项）。
   * ⛔ 缺席不许被当成某个默认 runtime：那会让一个纯终端标签顶着「Codex」的名字。
   */
  it('shells 元素能区分「纯终端」与「跑着某个 CLI」', () => {
    const frame: TerminalServerFrame = {
      type: 'shells',
      shells: [{ shellId: 'a'.repeat(32) }, { shellId: 'b'.repeat(32), runtimeId: 'claude-code' }],
    };
    const shells = frame.type === 'shells' ? (frame.shells ?? []) : [];
    expect(shells[0]?.runtimeId).toBeUndefined();
    expect(shells[1]?.runtimeId).toBe('claude-code');
  });

  /**
   * ⭐ `kind` 的三个值 —— ⛔ 别把 `agent` 和 `runtime` 混起来（06 §5.6）。
   *
   * `agent` 是**这个 Task 自己**那个 `platform-agent` 会话（provision 起的、关不掉）；
   * `runtime` 是用户随手开的一个 CLI 标签（独立会话、可关、跟任务没关系）。
   */
  it('kind 是三值，且 agent ≠ runtime', () => {
    const kinds: TerminalSessionKind[] = ['agent', 'shell', 'runtime'];
    expect(kinds).toHaveLength(3);
    expect(RUNTIME_ID_RE.test('claude-code')).toBe(true);
    expect(RUNTIME_ID_RE.test('codex')).toBe(true);
    // argv 侧的形状闸门（它会进 tmux 负载里的 set-option 参数）。
    expect(RUNTIME_ID_RE.test('')).toBe(false);
    expect(RUNTIME_ID_RE.test('a b')).toBe(false);
    expect(RUNTIME_ID_RE.test("x';id;'")).toBe(false);
  });

  /**
   * ⛔ **agent 会话不许被任何一帧销毁**（裁决 D-15）。这条钉的是形状层的保证：
   * shellId 的字符集里没有 `-`，所以 `platform-agent` 永远不是一个合法 shellId，
   * `shellSessionName()` 也就永远拼不出那个名字。
   */
  it('shellId 的形状本身就把 platform-agent 挡在外面', () => {
    expect(isTerminalShellId('a'.repeat(32))).toBe(true);
    expect(isTerminalShellId('platform-agent')).toBe(false);
    expect(isTerminalShellId('$(id)')).toBe(false);
    expect(isTerminalShellId('A'.repeat(32))).toBe(false); // 大写不算
    expect(isTerminalShellId('a'.repeat(31))).toBe(false);
    expect(isTerminalShellId(undefined)).toBe(false);
  });
});

describe('sandbox.instance_progress frame (10 §7.4)', () => {
  it('is assignable with the boundary phase and the one optional fact', () => {
    const frames: SandboxWsEvent[] = [
      { event: 'sandbox.instance_progress', sandboxId: 's1', phase: 'starting' },
      {
        event: 'sandbox.instance_progress',
        sandboxId: 's1',
        phase: 'starting',
        imageStaged: false,
      },
      { event: 'sandbox.instance_progress', sandboxId: 's1', phase: 'ready' },
    ];
    expect(frames).toHaveLength(3);
  });

  it('carries NO percentage and NO elapsed field — both would have to be invented', () => {
    // ① `provider.start()` is one await: 「开始」/「结束」 and nothing between, so a
    //    percentage has no honest source (cf. the deleted `clone_progress.totalBytes`).
    // ② elapsed ms is derivable by the only party that would read it — the frontend
    //    times from the `starting` it received. A field whose reader can compute it
    //    alone is a field that only adds a way to disagree.
    const segment = WS_PROTOCOL_CANONICAL.split('sandbox.instance_progress')[1] ?? '';
    const fields = segment.slice(1, segment.indexOf('}'));
    expect(fields.split(',')).toEqual(['sandboxId', 'phase', 'imageStaged?']);
  });
});

describe('runtime.install_progress frame (10 §3.1)', () => {
  it('is assignable with the four documented fields', () => {
    const frame: SandboxWsEvent = {
      event: 'runtime.install_progress',
      sandboxId: 's1',
      runtime: 'claude-code',
      status: 'installing',
      versionDetected: undefined,
      errorCode: undefined,
    };
    expect(frame.event).toBe('runtime.install_progress');
  });
});

/**
 * The `/tasks` handshake constant, held to EXACTLY the discipline `/terminal` is held
 * to above.
 *
 * ⚠️ WHAT THIS FILE IS FOR. `WS_TASKS_SCHEMA_HASH` is a hand-pinned literal that must
 * byte-equal a literal hardcoded in the frontend, and it is NOT derived from the frame
 * types — nothing makes it move when a frame shape moves. Its only previous "use" was
 * an e2e that fed the constant back to itself, which is true by construction and
 * therefore proves nothing. The pair of assertions below is the actual gate: the hash
 * and the canonical description of what it stands for are pinned TOGETHER, so changing
 * a `/tasks` frame shape fails here until the hash is bumped in lockstep — which is the
 * only moment anyone would remember to tell the other repo.
 */
describe('/tasks channel — the hash and the frame shapes it stands for (14 §2.5)', () => {
  it('pins the cross-repo literal, separately from /terminal', () => {
    expect(WS_TASKS_SCHEMA_HASH).toBe('sb-tasks-v1');
    // the two channels version INDEPENDENTLY: a task-frame change must not invalidate
    // every open terminal, and vice versa. Equal values would silently couple them.
    expect(WS_TASKS_SCHEMA_HASH).not.toBe(WS_SCHEMA_HASH);
  });

  it('the /tasks frame shapes did NOT change, so the pinned hash still stands', () => {
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'tasks.client:subscribe{taskId,fromSeq?},unsubscribe{taskId},ping|' +
        'tasks.server:event{taskId,seq,event},caught_up{taskId,firstSeq,seq},' +
        'exit{taskId,status,exitCode?},error{taskId,code},pong',
    );
  });

  it('`caught_up` carries firstSeq — the field a truncated replay is detected with', () => {
    // Without `firstSeq` a subscriber can only see a gap in the MIDDLE of the stream; a
    // head that was dropped looks exactly like a stream that legitimately starts there.
    expect(WS_PROTOCOL_CANONICAL).toContain('caught_up{taskId,firstSeq,seq}');
    const frame: TaskServerFrame = { type: 'caught_up', taskId: 't1', firstSeq: 5, seq: 9 };
    expect(frame).toMatchObject({ firstSeq: 5 });
  });

  it('every server frame the backend actually sends is in the union', () => {
    const frames: TaskServerFrame[] = [
      {
        type: 'event',
        taskId: 't',
        seq: 1,
        // ⚠️ `agent-message` 的 data 是 `{ text: string }`（契约 runtime-adapter §RuntimeEvent），
        //    不是空对象 —— 这个替身此前与契约对不上（2026-09-05 补）。
        event: { type: 'agent-message', timestamp: '', data: { text: '' } },
      },
      { type: 'caught_up', taskId: 't', firstSeq: 1, seq: 0 },
      { type: 'exit', taskId: 't', status: 'killed' },
      { type: 'error', taskId: 't', code: 'TASK_FAILED' },
      { type: 'pong' },
    ];
    expect(frames.map((f) => f.type)).toEqual(['event', 'caught_up', 'exit', 'error', 'pong']);
  });

  it('the client union is the three control frames and nothing else', () => {
    const frames: TaskClientFrame[] = [
      { type: 'subscribe', taskId: 't', fromSeq: 3 },
      { type: 'unsubscribe', taskId: 't' },
      { type: 'ping' },
    ];
    expect(frames.map((f) => f.type)).toEqual(['subscribe', 'unsubscribe', 'ping']);
  });
});
