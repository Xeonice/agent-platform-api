/**
 * 一次占用的三个维度（03 §1 `ResourceQuota`）。
 *
 * ⚠️ **domain 侧重新声明，不 import contracts**（01 §3 的分层规则，`eslint-plugin-boundaries`
 * 会拦）。与 `AutomationRunStatus` 在 automation 域里重新声明 13 §2.7.2 的 8 值是同一条
 * 纪律：领域模型不许依赖对外契约包 —— 否则「契约改一个字段」就会直接改写领域的语义，
 * 而那正是两者要分开的原因。
 *
 * 它与 `@platform/contracts` 的 `ResourceQuota` **结构相同**（TypeScript 结构化类型，
 * 因此 application 层在两者之间传递无需转换）。两处一起漂移的风险由
 * `provider.create({ quota })` 的类型检查兜住：字段名或类型一改，编译当场红。
 */
export interface ResourceQuota {
  cores: number;
  ramMb: number;
  diskMb: number;
}
