import { Injectable } from '@nestjs/common';
import { statSync } from 'node:fs';
import { readPublicNetworkConfig } from '../config/public-network';

/** Per-app counters; no file writes, VM calls, or background work are performed here. */
@Injectable()
export class DeploymentState {
  private readonly drainFile = readPublicNetworkConfig().drainFile;
  private requests = 0;
  private readonly socketCounts = new Set<() => number>();

  get draining(): boolean {
    if (!this.drainFile) return false;
    try {
      statSync(this.drainFile);
      return true;
    } catch (error) {
      // An inaccessible barrier must fail closed, rather than silently accept new work.
      return !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
    }
  }

  beginRequest(): () => void {
    this.requests++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.requests--;
    };
  }

  observeSockets(readCount: () => number): () => void {
    this.socketCounts.add(readCount);
    return () => {
      this.socketCounts.delete(readCount);
    };
  }

  get inFlightHTTP(): number {
    return this.requests;
  }
  get activeWS(): number {
    return [...this.socketCounts].reduce((sum, count) => sum + count(), 0);
  }
}
