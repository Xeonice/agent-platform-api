import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { TRIGGERED_BY as CONTRACT_TRIGGERED_BY } from '@platform/contracts';
import { TRIGGERED_BY as DOMAIN_TRIGGERED_BY } from '../../src/domain/entities/state-transition.entity';

/**
 * `triggered_by` 五值的**三份手抄**对账（13 §2.1.2）——与同目录 `status-enum-parity.spec.ts`
 * 是同一手法、同一理由，只是换了一个枚举：
 *
 *   ① 契约 `packages/contracts/src/schemas/enums.ts` 的 `TRIGGERED_BY`
 *   ② 领域 `state-transition.entity.ts` 的 `TRIGGERED_BY`
 *   ③ 已提交 migration 里的 `transitions_triggered_by_ck`（DB CHECK）
 *
 * ①②**拆不掉**：`eslint-plugin-boundaries` 禁止 domain 依赖 contracts，所以只能并存；
 * 测试文件是 boundaries 的豁免区（`boundaries/ignore`），这里因此是**唯一**能同时看见
 * 两边的地方。
 *
 * ⚠️ **为什么要一条专门的对账，而不是靠现成的那个钉子。** 此前唯一会因为漂移而变红的
 * 地方是 `audit.projector.ts` 底部 `transitionActor()` 的返回类型标注
 * （`(by: TriggeredBy): AuditActor`）——但那个函数是修 actor 漂移时的**副作用**：它整个
 * 函数体只有 `return by`，任何人重构 projector 时都可能顺手把它内联掉，理由充分且看起来
 * 无害。钉子一拔，两份清单就重新开始悄悄漂移。
 *
 * 漂移的代价不是抽象的：`AUDIT_ACTORS` 曾经是手抄的，于是清单里写着后端一处都不写的
 * `mcp` / `automation`，而后端每次 provision 都在写的 `scheduler`、projector 原样透传的
 * `health-check` / `provider-event` 一个都不在——前端 `ACTOR_LABELS` 按清单做，在中文
 * 界面上直接漏出英文标识符，**没有任何测试会红**。
 *
 * ③ 的代价更直接：DB CHECK 少一个值，那个 actor 的每一次状态流转都会在写
 * `sandbox_state_transitions` 时被 SQLite 拒掉。
 */

/**
 * 从**已提交的** migration 里解析 `transitions_triggered_by_ck` 的允许集。
 *
 * ⚠️ 扫全部 `.sql` 并取**最后一次**定义，而不是 `find()` 第一个文件：后来的 migration
 * 若重建这张表（SQLite 改 CHECK 只能 `__new_*` + 拷贝），约束会再出现一次，而生效的是
 * 最后那一份。只看第一个文件的写法在那天会指着一份历史快照说「集合相等」。
 */
function dbCheckTriggeredBy(): string[] {
  const dir = resolve(process.cwd(), 'drizzle');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let last: string[] | undefined;
  for (const f of files) {
    const sql = readFileSync(resolve(dir, f), 'utf8');
    for (const m of sql.matchAll(/transitions_triggered_by_ck[\s\S]*?IN\s*\(([^)]+)\)/gi)) {
      last = [...m[1].matchAll(/'([^']+)'/g)].map((g) => g[1]);
    }
  }
  if (last === undefined)
    throw new Error('transitions_triggered_by_ck not found in ./drizzle/*.sql');
  return last;
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('TriggeredBy 的三份手抄不许漂移', () => {
  it('领域 TRIGGERED_BY === 契约 TRIGGERED_BY（逐字，不是「大致对得上」）', () => {
    expect(sorted(DOMAIN_TRIGGERED_BY)).toEqual(sorted(CONTRACT_TRIGGERED_BY));
  });

  it('DB CHECK 的允许集 === 契约 TRIGGERED_BY', () => {
    expect(sorted(dbCheckTriggeredBy())).toEqual(sorted(CONTRACT_TRIGGERED_BY));
  });

  it('三份都恰好是 13 §2.1.2 的 5 个值', () => {
    expect(DOMAIN_TRIGGERED_BY).toHaveLength(5);
    expect(CONTRACT_TRIGGERED_BY).toHaveLength(5);
    expect(dbCheckTriggeredBy()).toHaveLength(5);
  });
});
