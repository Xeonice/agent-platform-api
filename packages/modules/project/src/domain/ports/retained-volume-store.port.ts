import type { Readable } from 'node:stream';

/** 一个保留卷的两个大小 —— **差一个数量级，两个都要**（13 §2.2.2）。 */
export interface RetainedVolumeMeasurement {
  /** 宿主目录实占（`du` 口径）。回答「删掉能拿回多少磁盘」。 */
  diskBytes: number;
  /** 打包后的 tar 字节数。回答「下载要等多久」，也是 `Content-Length`。 */
  downloadBytes: number;
}

export interface RetainedVolumeArchive {
  stream: Readable;
  /**
   * **精确**字节数 —— 下载响应的 `Content-Length` 就是它。
   * 见 `tar-archive.ts`：不压缩换来的就是这一个可以先发出去的数。
   */
  sizeBytes: number;
}

/**
 * 保留卷的**文件系统那一半**（03 §7.7「目录是事实，表是索引与保留期账本」）。
 *
 * 做成 port 而不是让 application 直接 `node:fs`：application 层按 01 §3 只能依赖
 * contracts / shared-kernel / 本模块 domain，而且「怎么挑内容打包」是一条会被
 * P21-8 §4 的备份复用的实现细节（10 §6：**别写第二套打包路径**），它属于 adapter。
 */
export interface RetainedVolumeStore {
  exists(workspacePath: string): Promise<boolean>;
  measure(workspacePath: string): Promise<RetainedVolumeMeasurement>;
  openArchive(workspacePath: string): Promise<RetainedVolumeArchive>;
  /** `rm -rf`。目录已经不在 ⇒ no-op（幂等，reaper 与手动清理都要重放）。 */
  remove(workspacePath: string): Promise<void>;
}

export const RETAINED_VOLUME_STORE = Symbol('RetainedVolumeStore');
