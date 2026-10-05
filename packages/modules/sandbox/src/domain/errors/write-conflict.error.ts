export class SandboxWriteConflictError extends Error {
  constructor() {
    super('任务状态已经改变，请刷新后再操作。');
  }
}

export class SandboxProjectHasActiveTasksError extends Error {
  constructor(readonly tasks: { id: string; name: string }[]) {
    super('项目下还有活跃任务，先停止或销毁后再删除项目。');
  }
}
