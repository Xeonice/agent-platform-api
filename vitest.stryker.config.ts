// Stryker 的入口 config（29 §3.3）：@stryker-mutator/vitest-runner 只接受普通 config，
// 不接受 defineWorkspace 的产物（会报 `config must export or return an object`），
// 所以真正的 project 定义在 vitest.stryker.workspace.ts 里，这里只做转发。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { workspace: './vitest.stryker.workspace.ts' },
});
