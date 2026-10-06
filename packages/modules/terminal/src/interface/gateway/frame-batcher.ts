import { StringDecoder } from 'node:string_decoder';

/** Decode split UTF-8 bytes and forward the same 16ms batch to the browser and observer. */
export class TerminalOutputBatcher {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly send: (data: string) => void) {}

  write(chunk: Buffer): void {
    if (this.closed) return;
    this.pending += this.decoder.write(chunk);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 16);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || this.pending === '') return;
    const data = this.pending;
    this.pending = '';
    this.send(data);
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
    this.closed = true;
  }
}
