import { describe, expect, it } from 'vitest';
import { streamed } from '../../../src/platform/system/preset-image/callback-stream';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('streamed —— 边跑边发，不是回放', () => {
  it('⛔ **回调发出来的那一刻就能被消费到**（收进数组等结束再喷会在这里红）', async () => {
    let emit!: (s: string) => void;
    let finish!: () => void;
    const gen = streamed<string>((e) => {
      emit = e;
      return new Promise<void>((r) => {
        finish = r;
      });
    });

    // 操作**还没结束**，第一条就必须拿得到 —— 这正是「回放」写法做不到的那一步。
    const first = gen.next();
    await tick();
    emit('20%');
    expect((await first).value).toBe('20%');

    const second = gen.next();
    await tick();
    emit('80%');
    expect((await second).value).toBe('80%');

    finish();
    expect((await gen.next()).done).toBe(true);
  });

  it('操作已结束、队列里还压着的那些，一条都不能少', async () => {
    const got: string[] = [];
    for await (const s of streamed<string>((emit) => {
      emit('a');
      emit('b');
      emit('c');
      return Promise.resolve();
    })) {
      got.push(s);
    }
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('⛔ 操作失败必须从消费端抛出来——只停住会让一次失败的搬运看起来成功了', async () => {
    const run = async (): Promise<string[]> => {
      const got: string[] = [];
      for await (const s of streamed<string>((emit) => {
        emit('推到一半');
        return Promise.reject(new Error('registry 断了'));
      })) {
        got.push(s);
      }
      return got;
    };
    await expect(run()).rejects.toThrow('registry 断了');
  });

  it('⛔ 失败前已经发生的进度不许丢——「推到 80% 才断」与「一开始就断」是两个问题', async () => {
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const s of streamed<string>((emit) => {
          emit('80%');
          return Promise.reject(new Error('断了'));
        })) {
          got.push(s);
        }
      })(),
    ).rejects.toThrow('断了');
    expect(got).toEqual(['80%']);
  });

  it('一条进度都没有的操作 ⇒ 干净结束，不挂住', async () => {
    const got: string[] = [];
    for await (const s of streamed<string>(() => Promise.resolve())) got.push(s);
    expect(got).toEqual([]);
  });
});
