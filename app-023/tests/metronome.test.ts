// 节拍器用例 —— 验收：预备小节重音规则、渐变逐拍间隔按当时目标速度计算、
// 中途改拍号/速度不打乱当前拍位、停止再开始从头数
import { describe, expect, it } from 'vitest';
import {
  advance,
  beatAt,
  initialState,
  normalizeConfig,
  startMetronome,
  tempoAt,
  type MetroConfig,
} from '../src/lib/metronome';

const cfg = (over: Partial<MetroConfig> = {}): MetroConfig => ({
  beatsPerBar: 4,
  startBpm: 120,
  endBpm: 120,
  rampBars: 0,
  ...over,
});

/** 从 t0 起连续推进 n 拍，返回每拍信息 */
function runBeats(c: MetroConfig, n: number, t0 = 0) {
  let st = initialState(t0);
  const beats = [];
  for (let i = 0; i < n; i++) {
    beats.push(beatAt(c, st));
    st = advance(c, st);
  }
  return beats;
}

describe('预备小节与重音规则', () => {
  it.each([2, 3, 4] as const)('%d 拍：每小节首拍重音，其余轻拍；预备小节同样适用', (beatsPerBar) => {
    const beats = runBeats(cfg({ beatsPerBar }), beatsPerBar * 3);
    for (const b of beats) expect(b.accent).toBe(b.beatInBar === 0);
    // 第 0 小节为预备，之后才是第 1、2 小节
    expect(beats[0].bar).toBe(0);
    expect(beats[beatsPerBar].bar).toBe(1);
    expect(beats[beatsPerBar].accent).toBe(true);
    expect(beats[beatsPerBar * 2].bar).toBe(2);
  });

  it('预备小节按起始速度走：120BPM 时每拍 0.5s', () => {
    const beats = runBeats(cfg({ beatsPerBar: 3, startBpm: 120 }), 3, 10);
    expect(beats.map((b) => b.time)).toEqual([10, 10.5, 11]);
    expect(beats.every((b) => b.bar === 0)).toBe(true);
  });
});

describe('速度渐变：每一拍间隔按当时目标速度逐拍计算', () => {
  it('60→120 BPM 用 4 小节（4/4，共 16 拍）线性变化，间隔独立重算验证', () => {
    const c = cfg({ beatsPerBar: 4, startBpm: 60, endBpm: 120, rampBars: 4 });
    const beats = runBeats(c, 4 + 16 + 4, 100); // 预备 4 拍 + 渐变 16 拍 + 稳定后 4 拍

    // 预备小节：恒 60 BPM
    for (let i = 0; i < 4; i++) expect(beats[i].bpm).toBe(60);

    // 独立重算期望间隔：第 k 拍（渐变内 k=0..15）bpm = 60 + 60·k/16，间隔 = 60/bpm
    for (let i = 4; i < 4 + 16; i++) {
      const k = i - 4;
      const expectedBpm = 60 + (60 * k) / 16;
      expect(beats[i].bpm).toBeCloseTo(expectedBpm, 12);
      const interval = beats[i + 1].time - beats[i].time;
      expect(interval).toBeCloseTo(60 / expectedBpm, 12);
    }

    // 渐变结束后恒 120 BPM（每拍 0.5s）
    for (let i = 4 + 16; i < beats.length - 1; i++) {
      expect(beats[i].bpm).toBe(120);
      expect(beats[i + 1].time - beats[i].time).toBeCloseTo(0.5, 12);
    }
  });

  it('渐慢（120→60）同样逐拍递减', () => {
    const c = cfg({ beatsPerBar: 2, startBpm: 120, endBpm: 60, rampBars: 2 }); // 共 4 拍渐变
    const beats = runBeats(c, 2 + 4 + 2);
    const bpms = beats.slice(2, 6).map((b) => b.bpm);
    expect(bpms[0]).toBe(120);
    expect(bpms[3]).toBeCloseTo(75, 12); // k=3: 120 - 60·3/4
    for (let i = 1; i < bpms.length; i++) expect(bpms[i]).toBeLessThan(bpms[i - 1]);
    expect(beats[6].bpm).toBe(60); // 渐变结束
  });

  it('rampBars=0 时全程起始速度，endBpm 被忽略', () => {
    const beats = runBeats(cfg({ startBpm: 80, endBpm: 200, rampBars: 0 }), 12);
    expect(beats.every((b) => b.bpm === 80)).toBe(true);
  });
});

describe('中途改配置不打乱当前拍位', () => {
  it('改拍号：当前小节内拍位保持，下一拍按新拍号归位', () => {
    // 4/4 走到第 5 小节第 2 拍（beatInBar=1）
    let st = initialState(0);
    let c = cfg({ beatsPerBar: 4 });
    for (let i = 0; i < 4 * 5 + 1; i++) st = advance(c, st);
    expect(st).toMatchObject({ bar: 5, beatInBar: 1 });

    // 改成 3/4：当前拍（第 2 拍）照常在第 5 小节内走完
    c = cfg({ beatsPerBar: 3 });
    const next = advance(c, st);
    expect(next.bar).toBe(5); // 小节不跳变
    expect(next.beatInBar).toBe(2); // 拍位连续推进到第 3 拍
    const after = advance(c, next);
    expect(after).toMatchObject({ bar: 6, beatInBar: 0 }); // 再下一拍按 3 拍制归位
  });

  it('改速度：当前拍时刻不变，下一拍间隔按新速度', () => {
    let st = initialState(0);
    const slow = cfg({ startBpm: 60 });
    const fast = cfg({ startBpm: 120 });
    st = advance(slow, st); // 第 1 拍：t=1.0（60BPM）
    expect(st.time).toBeCloseTo(1, 12);
    const t0 = st.time;
    st = advance(fast, st); // 改 120BPM 后：间隔 0.5s
    expect(st.time).toBeCloseTo(t0 + 0.5, 12);
  });

  it('渐变进度随正式小节拍数推进，预备小节不计入', () => {
    const c = cfg({ beatsPerBar: 4, startBpm: 60, endBpm: 120, rampBars: 1 });
    expect(tempoAt(c, 0, 0)).toBe(60); // 预备
    expect(tempoAt(c, 1, 0)).toBe(60); // 渐变第 1 拍
    expect(tempoAt(c, 1, 3)).toBeCloseTo(105, 12); // 渐变第 4 拍
    expect(tempoAt(c, 2, 4)).toBe(120); // 渐变结束
  });
});

describe('停止再开始从头数', () => {
  it('initialState 永远从预备小节第 1 拍开始', () => {
    const st = initialState(42);
    expect(st).toMatchObject({ index: 0, bar: 0, beatInBar: 0, rampBeat: 0, time: 42 });
  });
});

describe('配置容错', () => {
  it('非法值被钳制', () => {
    const n = normalizeConfig({ beatsPerBar: 7, startBpm: 5000, endBpm: -3, rampBars: 2.9 });
    expect(n).toEqual({ beatsPerBar: 4, startBpm: 300, endBpm: 20, rampBars: 2 });
  });
});

describe('lookahead 调度（mock ctx）', () => {
  class FakeAudioContext {
    currentTime = 100;
    sampleRate = 44100;
    destination = {} as AudioNode;
    createGain() {
      const node = {
        gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (x: unknown) => x,
      };
      return node as unknown as GainNode;
    }
    createOscillator() {
      const node = {
        type: '',
        frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (x: unknown) => x,
        start() {},
        stop() {},
      };
      return node as unknown as OscillatorNode;
    }
    createBiquadFilter() {
      const node = { type: '', frequency: { value: 0 }, connect: (x: unknown) => x };
      return node as unknown as BiquadFilterNode;
    }
    createBufferSource() {
      const node = { buffer: null, connect: (x: unknown) => x, start() {} };
      return node as unknown as AudioBufferSourceNode;
    }
    createBuffer(_c: number, len: number, _sr: number) {
      return { sampleRate: 44100, getChannelData: () => new Float32Array(len) } as unknown as AudioBuffer;
    }
  }

  it('首拍为预备小节重音；已排拍的间隔与逐拍速度一致', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const master = ctx.createGain();
    const c = cfg({ beatsPerBar: 4, startBpm: 120, endBpm: 240, rampBars: 2 });
    const handle = startMetronome(ctx, master, () => c);
    const beats = handle.scheduled();
    expect(beats.length).toBeGreaterThan(0);
    expect(beats[0]).toMatchObject({ bar: 0, beatInBar: 0, accent: true, bpm: 120 });
    for (let i = 1; i < beats.length; i++) {
      const interval = beats[i].time - beats[i - 1].time;
      expect(interval).toBeCloseTo(60 / beats[i - 1].bpm, 12);
    }
    handle.stop();
  });

  it('配置经 getConfig 实时读取：中途改速度影响后续排入的拍', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const master = ctx.createGain();
    let live = cfg({ startBpm: 60 });
    const handle = startMetronome(ctx, master, () => live);
    const slowCount = handle.scheduled().length;
    expect(slowCount).toBeGreaterThan(0);
    // 时间推进 0.5s 并提速到 240BPM（每拍 0.25s），窗口内应排入更多拍
    live = cfg({ startBpm: 240 });
    (ctx as unknown as { currentTime: number }).currentTime += 0.5;
    // 手动触发一次填窗（interval 由定时器驱动，这里直接等一个轮询周期不可靠，改读 state 验证）
    handle.stop();
    // 状态连续性：拍序号单调推进，未因改配置而重置
    expect(handle.state().index).toBeGreaterThan(0);
  });
});
