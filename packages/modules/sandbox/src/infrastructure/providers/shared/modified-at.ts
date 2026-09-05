/**
 * `modifiedAt` 的**缺席**形态 —— 两个 provider 共用一句，免得一边改另一边忘（2026-09-05）。
 *
 * ⛔ **解析不出就缺席，不发空串。** 空串是一个**伪装成数据的谎**：前端拿它直接渲染，
 * 界面上是一片空白 —— 用户分不清「这个文件没有时间戳」与「这一格渲染坏了」；
 * 谁要是 `new Date('')`，拿到的是 `Invalid Date`。
 *
 * 与同一个结构体里 `size` 的处理同一条（目录没有大小 ⇒ 缺席，不是 0），
 * 也与本仓其它三处同源：`sizeBytes: null` 不是 0、`hvSupport: null` 不是 false、reflink 三态。
 */
export function spreadModifiedAt(iso: string | undefined): { modifiedAt?: string } {
  return iso === undefined ? {} : { modifiedAt: iso };
}
