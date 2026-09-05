import { createReadStream } from 'node:fs';
import { Inject, Injectable } from '@nestjs/common';
import { DOCKER_CLIENT } from '@platform/sandbox';
import type { PresetImageDockerPort } from './preset-image-provisioner';

/**
 * `PresetImageDockerPort` 的 dockerode 实现 —— 唯一碰 docker 的那一层。
 *
 * ⚠️ **搬运器只认那个三方法端口，不认 dockerode。** 于是「搬运的判据」全部可以在纯单测里
 * 钉住，而这一层只剩下「把 dockerode 的流翻译成进度」这一件不得不真跑才知道的事。
 *
 * ⚠️ **复用 sandbox 模块已经绑好的 `DOCKER_CLIENT`，不自己再 new 一个。** 曾经想在这里
 * 按同样的 env 契约（`DOCKER_HOST` / `DOCKER_SOCKET`）另建一个客户端 —— 那会造出**两份
 * env 解读**，于是「沙箱连得上 docker、搬运连不上」这种谁都没错的组合迟早出现。
 * ⇒ token 从 sandbox 的公开面导出，platform 注入它；导出的是 token 不是实现，模块边界仍在。
 */
@Injectable()
export class DockerodeProvisionAdapter implements PresetImageDockerPort {
  constructor(@Inject(DOCKER_CLIENT) private readonly docker: DockerLike) {}

  async available(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 本机 docker 镜像库里有没有这个 tag。
   *
   * ⚠️ **404 是「没有」，不是错误。** dockerode 对不存在的镜像抛错，把它当失败会让
   * `plan()` 走进「探测失败」那条降级路 —— 结论一样，但日志里会多一条吓人的报错。
   */
  async hasImage(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async push(ref: string, onProgress: (p: number | null, msg: string) => void): Promise<void> {
    const stream = await this.docker.getImage(ref).push({});
    return this.follow(stream, onProgress, `推送 ${ref}`);
  }

  async loadArchive(
    path: string,
    onProgress: (p: number | null, msg: string) => void,
  ): Promise<void> {
    const stream = await this.docker.loadImage(createReadStream(path));
    return this.follow(stream, onProgress, '装载镜像');
  }

  async tag(from: string, to: string): Promise<void> {
    const { repo, tag } = splitRefForTag(to);
    await this.docker.getImage(from).tag({ repo, tag });
  }

  /**
   * 跟一条 docker 的 JSON 流，把它翻译成进度。
   *
   * ⛔ **流里的 `errorDetail` 必须变成一次 reject。** docker 的 push/load 流会在 HTTP 200
   * 之下用流里的一条 `error` 报失败 —— 只看 HTTP 状态码的话，一次失败的推送看起来是成功的。
   * 那是「多报是撒谎」里最贵的一种：诊断随后仍然红，而用户刚看到搬运「成功」了。
   */
  private follow(
    stream: NodeJS.ReadableStream,
    onProgress: (p: number | null, msg: string) => void,
    what: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null, out: DockerProgressFrame[]) => {
          if (err !== null) return reject(err);
          const failed = out.find((f) => f.error !== undefined || f.errorDetail !== undefined);
          if (failed !== undefined) {
            return reject(
              new Error(`${what}失败：${failed.error ?? failed.errorDetail?.message ?? '未知'}`),
            );
          }
          resolve();
        },
        (frame: DockerProgressFrame) => {
          onProgress(fractionOf(frame), messageOf(frame, what));
        },
      );
    });
  }
}

/**
 * dockerode 客户端里**这一层用得到的那部分**。
 *
 * ⚠️ 写成结构类型而不是 `import Docker from 'dockerode'`：`dockerode` 是 sandbox 模块的
 * 依赖，apps/api 没有它 —— 为了一个类型标注在组合根再装一份依赖，是让依赖图去迁就类型标注。
 * 运行期注入的仍然是那个真客户端（`DOCKER_CLIENT`）。
 */
export interface DockerLike {
  ping(): Promise<unknown>;
  getImage(ref: string): {
    inspect(): Promise<unknown>;
    push(opts: Record<string, unknown>): Promise<NodeJS.ReadableStream>;
    tag(opts: { repo: string; tag: string }): Promise<unknown>;
  };
  loadImage(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream>;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      onFinished: (err: Error | null, out: DockerProgressFrame[]) => void,
      onProgress: (frame: DockerProgressFrame) => void,
    ): void;
  };
}

interface DockerProgressFrame {
  status?: string;
  id?: string;
  error?: string;
  errorDetail?: { message?: string };
  progressDetail?: { current?: number; total?: number };
}

/**
 * 一帧 → 0–1。
 *
 * ⚠️ **`total` 缺失或为 0 时返 null，不返 0。** 0 会让进度条显示「0%」并一直不动，
 * 与「卡住了」在观感上一样；null 让前端画不确定态（转圈），那才是实话。
 */
export function fractionOf(f: DockerProgressFrame): number | null {
  const cur = f.progressDetail?.current;
  const total = f.progressDetail?.total;
  if (typeof cur !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.min(1, cur / total);
}

export function messageOf(f: DockerProgressFrame, what: string): string {
  const status = f.status ?? what;
  return f.id === undefined ? status : `${status} ${f.id}`;
}

/**
 * `registry/name:tag` → dockerode `tag()` 要的 `{ repo, tag }`。
 *
 * ⚠️ **不能简单按最后一个 `:` 切**：`localhost:5001/platform/sandbox` 没有 tag，
 * 那个冒号是端口。⇒ 只有出现在**最后一段**里的冒号才是 tag 分隔符。
 */
export function splitRefForTag(ref: string): { repo: string; tag: string } {
  const slash = ref.lastIndexOf('/');
  const lastSegment = slash === -1 ? ref : ref.slice(slash + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon === -1) return { repo: ref, tag: 'latest' };
  const cut = (slash === -1 ? 0 : slash + 1) + colon;
  return { repo: ref.slice(0, cut), tag: ref.slice(cut + 1) };
}
