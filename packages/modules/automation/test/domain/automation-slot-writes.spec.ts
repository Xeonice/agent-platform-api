import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **I-AUT-10 的结构性守卫**（23 §11.1 / 03 §8.1）。
 *
 * 不变量本身是一句行为规约：*一个已到期的触发槽（`next_trigger_at <= now`），在被移出
 * 调度器扫描面之前，必须在 `automation_runs` 里留下恰好一行（triggered / skipped /
 * missed 之一）。* 行为侧的断言在 `automation.spec.ts` 与 `automation-scheduler.spec.ts`
 * 里各有一组。
 *
 * ⚠️ **但那两组只能证明「今天写的这几条路径是对的」。** 这个洞第一次出现，正是因为
 * 有人在 `recordOutcome` 里加了第 8 个写 `_nextTriggerAt` 的地方，而那一行看上去
 * 完全无害（注释还写着「降频/禁用会改变下一次算在哪」，说的也确实是它想做的事）。
 * 下一个人会在第 9 个地方再写一次 —— 除非这件事在**结构上**必须被回答。
 *
 * 所以：`_nextTriggerAt` 的每一个写口都必须在源码里带一个 `// slot: <去向>` 标记，
 * 而标记的词表是封闭的。想推走一个到期槽？词表里没有对应的词。
 *
 * ── 这条用例红了怎么办 ─────────────────────────────────────────────────────────
 * 说明有人新增/挪动了一个写 `_nextTriggerAt` 的地方。**先回答一个问题**：
 * 「这次写入，会不会让一个 `<= now` 的槽既没触发也没留下记录？」
 *   · 不会（只动未到期的槽）      ⇒ 走 `recomputeFutureTrigger()`，别自己算。
 *   · 会，但整条规则退出扫描面    ⇒ `slot: off-scan`，并确保有事件/审计在案。
 *   · 会，且伴随一行 run          ⇒ 那它就是 `advanceTrigger()`（I-AUT-8）。
 * 回答完再来改下面这张表。
 */
const ENTITY = resolve(__dirname, '../../src/domain/entities/automation.entity.ts');

/** 封闭词表 —— 每个词是一个「那个槽去哪了」的答案。⛔ 加词要先改 23 §11.1 的不变量。 */
const SLOT_TAGS = ['advance', 'create', 'off-scan', 'recompute', 'rehydrate'] as const;

/** 赋值语句（`x = y`），排除 `==` / `===` / `!==` / `<=` 这类比较。 */
const ASSIGNMENT = /_nextTriggerAt\s*=(?!=)/;
const TAG = /\/\/ slot: ([a-z-]+)$/;

/** 只留代码行：整行注释（`//` `/*` ` * `）里出现的赋值是**在讲**它，不是**在做**它。 */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trimStart();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

function slotWrites(source: string): string[] {
  return codeLines(source).filter((l) => ASSIGNMENT.test(l));
}

describe('I-AUT-10 结构性守卫：`_nextTriggerAt` 的每个写口都要说清「那个槽去哪了」', () => {
  const source = readFileSync(ENTITY, 'utf8');

  it('★★ 每一处赋值都带着 `// slot: …` 标记，且用的是封闭词表里的词', () => {
    const writes = slotWrites(source);
    // 正向证据：正则真的匹配到了东西（一个恒返回 [] 的 helper 会让下面的断言空转）
    expect(writes.length).toBeGreaterThan(0);

    for (const line of writes) {
      const tag = TAG.exec(line)?.[1];
      expect(tag, `未标注去向的槽位写入：${line.trim()}`).toBeDefined();
      expect(SLOT_TAGS, `未知的去向标记：${line.trim()}`).toContain(tag);
    }
  });

  it('★★ 写口的**清单**就是这五处 —— 多一处、少一处都要求先回答上面那个问题', () => {
    const tags = slotWrites(source)
      .map((l) => TAG.exec(l)?.[1])
      .sort();
    expect(tags).toEqual([
      'advance', // advanceTrigger()：触发本身，必伴随一行 run（I-AUT-8）
      'create', // create()：规则刚建，还没有槽
      'off-scan', // 连续失败自动禁用：整条规则退出扫描面（AutomationDisabled 在案）
      'off-scan', // disable()：同上，用户显式动作（automation.disabled 审计在案）
      'recompute', // recomputeFutureTrigger()：结构上只动未到期的槽
      'rehydrate', // 构造函数：从库里读回来，没动过
    ]);
  });

  it('★ 只有 `recomputeFutureTrigger` 里那一处允许「重算」—— 别处不许自己调 computeNextTrigger 去写槽', () => {
    // `advanceTrigger` 也调 `computeNextTrigger`，但它写的是 `slot: advance`。
    // 这里钉的是：带 `slot: recompute` 的赋值有且只有一处，即那个带早退保护的方法。
    const recompute = slotWrites(source).filter((l) => l.endsWith('// slot: recompute'));
    expect(recompute).toHaveLength(1);
    expect(recompute[0]).toContain('this.computeNextTrigger(now)');
  });

  it('★ 聚合之外没有第二个写口：全模块 `src/` 里只有这一个文件碰得到 `_nextTriggerAt`', () => {
    // 字段是 `private`，TS 已经拦住绝大多数写法；但 `Object.defineProperty` /
    // `(x as never)` 这类逃逸不受类型系统管，而它们恰恰是「绕过不变量」的典型手段。
    const src = resolve(__dirname, '../../src');
    const touching = walk(src).filter((f) => readFileSync(f, 'utf8').includes('_nextTriggerAt'));
    expect(touching).toEqual([ENTITY]);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}
