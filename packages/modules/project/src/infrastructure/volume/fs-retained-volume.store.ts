import { rm, stat } from 'node:fs/promises';
import { Injectable } from '@nestjs/common';
import {
  diskUsageBytes,
  listWorkspaceArchiveEntries,
  planTarArchive,
  tarReadable,
} from '@platform/shared-kernel';
import type {
  RetainedVolumeArchive,
  RetainedVolumeMeasurement,
  RetainedVolumeStore,
} from '../../domain/ports/retained-volume-store.port';

/**
 * 文件系统上的保留卷（03 §7.7）。产品术语叫「卷」，技术上是**目录**。
 *
 * 打包全部委托给 shared-kernel 的 `tar-archive`，那是平台**唯一**的打包机制 ——
 * P21-8 §4 的备份也走它（10 §6：各写一套会有两个打包路径、两处水位判断，以后修一个
 * 漏一个）。
 */
@Injectable()
export class FsRetainedVolumeStore implements RetainedVolumeStore {
  async exists(workspacePath: string): Promise<boolean> {
    try {
      return (await stat(workspacePath)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * ⚠️ 两个数**分别**量，不是一个数换算出来的。`diskBytes` 走已分配块（`du` 口径），
   * `downloadBytes` 走 git 口径挑出来的内容 + tar 的块头算术 —— 实测本仓 web 工作区
   * 前者 1.0 GB、后者 14 MB，**差 70 倍**。
   */
  async measure(workspacePath: string): Promise<RetainedVolumeMeasurement> {
    const [diskBytes, entries] = await Promise.all([
      diskUsageBytes(workspacePath),
      listWorkspaceArchiveEntries(workspacePath),
    ]);
    return { diskBytes, downloadBytes: planTarArchive(entries).totalBytes };
  }

  /**
   * ⚠️ **大小在下载这一刻重算，不读库里那个 `download_bytes`。** 响应头里的
   * `Content-Length` 必须描述**这一次**要发的字节流；库里那个数是登记时刻的事实，供
   * 列表页显示。两者正常情况下相等（保留卷属于已销毁的沙箱，没有写者），不等的时候
   * 该错的是列表上的一个数字，不是一条被截断的下载。
   */
  async openArchive(workspacePath: string): Promise<RetainedVolumeArchive> {
    const plan = planTarArchive(await listWorkspaceArchiveEntries(workspacePath));
    return { stream: tarReadable(plan), sizeBytes: plan.totalBytes };
  }

  async remove(workspacePath: string): Promise<void> {
    await rm(workspacePath, { recursive: true, force: true });
  }
}
