import { resolve } from 'node:path';

/**
 * Minimal env access (a zod-validated config module is a later slice; 01 platform/config).
 * Defaults are SAFE: bind loopback only (shared/11 §3, audit P0-3).
 */
export const env = {
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  dataRoot: process.env.DATA_ROOT ?? resolve(process.cwd(), 'data'),
  get databaseUrl(): string {
    return process.env.DATABASE_URL ?? resolve(this.dataRoot, 'platform.db');
  },
  get accessPasscode(): string {
    return process.env.ACCESS_PASSCODE ?? '';
  },
};

/** True when the bind address is not the loopback interface (triggers a warning). */
export function isExposedBind(host: string): boolean {
  return host !== '127.0.0.1' && host !== 'localhost' && host !== '::1';
}

export type BindExposure =
  | { readonly level: 'none' }
  | { readonly level: 'warn'; readonly message: string }
  | { readonly level: 'declared'; readonly message: string };

/**
 * 启动时该不该为「绑在 0.0.0.0」发一条告警 —— **以及为什么它不能无条件地发**。
 *
 * ── 它修的是什么（一条必然出现、又不代表出错的告警）────────────────────────
 * `docker-compose.yml` 自己设 `HOST=0.0.0.0`（**必须**如此：容器里绑 loopback，外面那行
 * `ports:` 就转不进来），而外侧暴露由 `ports: 127.0.0.1:3000:3000` 收住。于是 compose
 * 形态下**每一次启动都必然打这条 WARN，而每一次都不代表出错**。
 *
 * ⚠️ 一条恒真的告警不是「多一句话」，它训练用户忽略告警 —— 而这条告警存在的全部理由，
 * 是有朝一日真的有人把一个持有用户 runtime 凭证的实例挂到公网上时，它能被看见
 * （审计 P0-3）。恒响的报警器等于没有报警器。
 *
 * ── 为什么不能靠探测（与 shared/11 §1.4 同一条纪律）──────────────────────────
 * ⛔ 进程内看不见「外侧那行 `ports:` 发布在哪」。看 `/.dockerenv`、看 `SANDBOX_DOCKER_NETWORK`
 * 都只能回答「我像不像/是不是在容器里」，而在容器里**照样可以**被发布到 `0.0.0.0` ——
 * 靠它免掉告警就是拿一句猜测去关掉一个安全提示。
 *
 * ⇒ 与 `SANDBOX_DOCKER_NETWORK` 同一形状：**要一句显式声明，而不是一个开关**。
 * `HTTP_BIND_GATED_BY` 填的是「外侧由什么收住」这件事的人类可读答案（compose 里就是那行
 * `ports:`）。填了 ⇒ 降为一条 INFO，并把声明**原样打出来**：它因此是可审计的 —— 日志里
 * 留下的是运维方自己写下的那句话，而不是平台替他做的假设。留空 ⇒ 一字不变，照旧 WARN。
 *
 * ⚠️ 声明当然可能是假的（外侧其实发布在通配地址上）。所以 INFO 那句里明写这一点：
 * 平台能保证的是「有人为此签过字」，不是「它是真的」。这比让告警恒响诚实。
 */
export function describeBindExposure(host: string, gatedBy: string | undefined): BindExposure {
  if (!isExposedBind(host)) return { level: 'none' };
  const declaration = (gatedBy ?? '').trim();
  if (declaration === '') {
    return {
      level: 'warn',
      message:
        `HTTP is bound to ${host} — this instance may be reachable from the LAN/public. ` +
        'It holds user runtime credentials; prefer 127.0.0.1 + reverse proxy (shared/11 §3). ' +
        '若外侧已由别的东西收住（compose 的 `ports: 127.0.0.1:3000:3000`），' +
        '用 HTTP_BIND_GATED_BY 写下那句声明，这条告警会降为 INFO。',
    };
  }
  return {
    level: 'declared',
    message:
      `HTTP is bound to ${host}; 外侧暴露据声明由「${declaration}」收住（HTTP_BIND_GATED_BY）。` +
      '⚠️ 平台**验证不了**这句声明（进程内看不见外侧的发布地址）—— 它只是记下有人为此签过字。' +
      '若外侧其实发布在通配地址上，这个实例就在公网上，而它持有用户 runtime 凭证（shared/11 §3）。',
  };
}
