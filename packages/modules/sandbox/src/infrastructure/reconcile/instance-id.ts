import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** 容器上标记"我属于哪个平台实例"的标签名。 */
export const INSTANCE_LABEL = 'platform.instance';

/**
 * boxlite micro-VM 的名字前缀。**生产者与解析者共用这一个函数**——boxlite 没有
 * docker 那样的标签机制,身份只能编进名字,而"编进去"和"读出来"分处两个文件。
 *
 * ⚠️ 此前两边各自拼字符串:provider 拼 `platform-${this.name}-${id}-`,reconciler 拼
 * `${BOXLITE_NAME_PREFIX}${id}-`。单测钉住了「生产者 ↔ 测试」,却钉不住
 * 「生产者 ↔ reconciler」—— 改 reconciler 那个常量,生产者照样产旧格式,测试照样绿,
 * 而线上一个 box 都不回收。有共享常量可 import 时就没有漂移;退回字符串拼接,
 * 守卫就只能钉住三方中的两方。
 */
export function boxliteNamePrefix(): string {
  return `platform-boxlite-${platformInstanceId()}-`;
}

/**
 * 本实例的身份指纹。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 启动对账的规则是"带 `platform.managed=true` 但**不在库里**的容器 = 孤儿,强制删"。
 * 这在"一台机器只有一个平台实例"的假设下是对的,而那个假设**在开发机上不成立**:
 * e2e 用自己的临时库跑,于是开发者正开着的 demo 的沙箱在它眼里全是孤儿,
 * 一跑测试就被全部删掉。实际发生过三次,其中两次是在用户有任务在跑的时候。
 *
 * 修法不是"跑测试前记得关 demo"(那是纪律,靠不住),而是把"孤儿"的定义收窄到
 * **本实例管的容器**——语义上本来也该如此:一个实例凭什么去删另一个实例的东西。
 *
 * ── 为什么用库的位置当身份 ──────────────────────────────────────────────────
 * 因为决定"谁是孤儿"的就是那个库。共用同一个库的进程本来就是同一个平台
 * (重启前后、多进程),它们必须互认;库不同 = 两套账,谁也不该管谁。
 * 取 sha256 前 16 位:标签值要短、只做相等比较,不需要可逆。
 */
export function platformInstanceId(): string {
  const dataRoot = process.env.DATA_ROOT ?? resolve(process.cwd(), 'data');
  const db = process.env.DATABASE_URL ?? resolve(dataRoot, 'platform.db');
  return createHash('sha256').update(db).digest('hex').slice(0, 16);
}
