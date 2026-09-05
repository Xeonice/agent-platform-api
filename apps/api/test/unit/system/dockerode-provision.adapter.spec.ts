import { describe, expect, it } from 'vitest';
import {
  fractionOf,
  messageOf,
  splitRefForTag,
} from '../../../src/platform/system/preset-image/dockerode-provision.adapter';

describe('splitRefForTag —— 端口冒号不是 tag 冒号', () => {
  it('⛔ `localhost:5001/platform/sandbox:v2` 的两个冒号要分得开（简单按最后一个 `:` 切会错）', () => {
    expect(splitRefForTag('localhost:5001/platform/sandbox:v2')).toEqual({
      repo: 'localhost:5001/platform/sandbox',
      tag: 'v2',
    });
  });

  it('⛔ 没有 tag 但带端口 ⇒ 端口不许被当成 tag', () => {
    expect(splitRefForTag('localhost:5001/platform/sandbox')).toEqual({
      repo: 'localhost:5001/platform/sandbox',
      tag: 'latest',
    });
  });

  it.each([
    [
      'ghcr.io/xeonice/cap-boxlite-sandbox:v0.26.0',
      'ghcr.io/xeonice/cap-boxlite-sandbox',
      'v0.26.0',
    ],
    ['alpine:3.20', 'alpine', '3.20'],
    ['alpine', 'alpine', 'latest'],
  ])('%s ⇒ %s : %s', (ref, repo, tag) => {
    expect(splitRefForTag(ref)).toEqual({ repo, tag });
  });
});

describe('fractionOf —— 给不出就 null，不给 0', () => {
  it('给得出就算', () => {
    expect(fractionOf({ progressDetail: { current: 50, total: 200 } })).toBe(0.25);
  });

  it('⛔ total 缺失 / 为 0 ⇒ null，**不是 0**（0 会显示成一直不动的 0%，与卡死同观感）', () => {
    expect(fractionOf({})).toBeNull();
    expect(fractionOf({ progressDetail: { current: 5 } })).toBeNull();
    expect(fractionOf({ progressDetail: { current: 5, total: 0 } })).toBeNull();
  });

  it('current 超过 total 时封顶到 1（docker 偶尔会报超）', () => {
    expect(fractionOf({ progressDetail: { current: 300, total: 200 } })).toBe(1);
  });
});

describe('messageOf', () => {
  it('有 id 就带上（多层并行推送时要分得清是哪一层）', () => {
    expect(messageOf({ status: 'Pushing', id: 'a1b2' }, '推送')).toBe('Pushing a1b2');
  });

  it('status 缺失时回落到操作名，不出现 undefined', () => {
    expect(messageOf({}, '推送 x')).toBe('推送 x');
  });
});
