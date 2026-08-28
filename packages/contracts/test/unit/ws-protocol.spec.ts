import { describe, it, expect } from 'vitest';
import {
  WS_SCHEMA_HASH,
  WS_TASKS_SCHEMA_HASH,
  WS_PROTOCOL_CANONICAL,
  X_SCHEMA_HASH_HEADER,
} from '@platform/contracts';
import type { SandboxWsEvent, TaskClientFrame, TaskServerFrame } from '@platform/contracts';

/**
 * WS protocol handshake constant (docs/shared/14 §2.5). S1 pins WS_SCHEMA_HASH to
 * a shared literal that must byte-equal the frontend's hardcoded value so the
 * /terminal handshake actually agrees; the real codegen-hash toolchain is later.
 */
describe('WS protocol schema hash', () => {
  it('is the pinned cross-repo literal (must equal the frontend constant)', () => {
    expect(WS_SCHEMA_HASH).toBe('sb-terminal-v1');
    expect(X_SCHEMA_HASH_HEADER).toBe('x-schema-hash');
  });

  it('documents the canonical frame shapes it stands for', () => {
    expect(WS_PROTOCOL_CANONICAL).toContain('terminal.server:data{data}');
    expect(WS_PROTOCOL_CANONICAL).toContain('session{socketSessionKey}');
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

  it('the /terminal frame shapes did NOT change, so the pinned handshake hash stands', () => {
    // WS_SCHEMA_HASH gates the /terminal handshake only; adding an /events variant
    // must not break a frontend that pins the literal (14 §2.5).
    expect(WS_PROTOCOL_CANONICAL).toContain(
      'terminal.client:input{data},resize{cols,rows},ping|' +
        'terminal.server:data{data},exit{code},pong,session{socketSessionKey}',
    );
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
        event: { type: 'agent-message', timestamp: '', data: {} },
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
