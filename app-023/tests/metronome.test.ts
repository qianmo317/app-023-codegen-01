// 节拍器用例 —— 预备小节、重音规则、逐拍变速、播放中改配置不打乱拍位
import { describe, expect, it } from 'vitest';
import {
  advanceMetro,
  eventAt,
  initialMetroState,
  planBeats,
  startMetronome,
  tempoAtBar,
  type MetronomeConfig,
} from '../src/lib/metronome';

const cfg = (over: Partial<MetronomeConfig> = {}): MetronomeConfig => ({
  beatsPerBar: 4,
  bpm: 120,
  ramp: null,
  ...over,
});

describe('预备小节与重音', () => {
  it('首次事件是预备小节（bar 0）第 1 拍且为重音', () => {
    const st = initialMetroState(cfg(), 10);
    const ev = eventAt(st);
    expect(ev.bar).toBe(0);
    expect(ev.beat).toBe(0);
    expect(ev.accent).toBe(true);
  });

  it.each([2, 3, 4] as const)('%d 拍小节：每小节仅首拍重音，其余轻音', (n) => {
    const evs = planBeats(cfg({ beatsPerBar: n, bpm: 60 }), 2, 0);
    expect(evs).toHaveLength(n * 3); // 预备 + 2 个正小节
    // 每小节 0 拍 accent，其余不 accent
    for (const ev of evs) {
      expect(ev.accent).toBe(ev.beat === 0);
    }
    // bar 编号序列
    const bars = evs.map((e) => e.bar);
    expect(bars).toEqual(Array.from({ length: n }, () => 0).concat(Array.from({ length: n }, () => 1), Array.from({ length: n }, () => 2)));
  });

  it('预备小节也按同样重音规则走（每小节首拍重音）', () => {
    const evs = planBeats(cfg({ beatsPerBar: 4 }), 1, 0);
    const countIn = evs.filter((e) => e.bar === 0);
    expect(countIn.map((e) => e.accent)).toEqual([true, false, false, false]);
  });
});

describe('恒速拍间隔', () => {
  it('120 BPM 时相邻拍间隔恒为 0.5s，无累积漂移', () => {
    const evs = planBeats(cfg({ bpm: 120 }), 3, 100);
    for (let i = 1; i < evs.length; i++) {
      expect(evs[i].time - evs[i - 1].time).toBeCloseTo(0.5, 12);
    }
    // 末拍时刻独立重算：16 拍（预备+3小节）×0.5
    expect(evs[evs.length - 1].time).toBeCloseTo(100 + 15 * 0.5, 12);
  });

  it('60 BPM 时相邻拍间隔恒为 1s', () => {
    const evs = planBeats(cfg({ bpm: 60, beatsPerBar: 3 }), 1, 0);
    expect(evs[1].time - evs[0].time).toBeCloseTo(1, 12);
  });
});

describe('渐变速（每拍间隔按当时目标速度逐拍算）', () => {
  const rampCfg = cfg({ bpm: 60, beatsPerBar: 4, ramp: { toBpm: 120, bars: 4 } });

  it('预备小节恒用起始速度', () => {
    expect(tempoAtBar(rampCfg, 0)).toBe(60);
    const evs = planBeats(rampCfg, 2, 0);
    const countIn = evs.filter((e) => e.bar === 0);
    for (let i = 1; i < countIn.length; i++) {
      expect(countIn[i].time - countIn[i - 1].time).toBeCloseTo(1, 12);
    }
  });

  it('各正小节目标速度线性插值，走完后保持目标速度', () => {
    expect(tempoAtBar(rampCfg, 1)).toBe(60); // 第 1 正小节起点
    expect(tempoAtBar(rampCfg, 2)).toBe(75);
    expect(tempoAtBar(rampCfg, 3)).toBe(90);
    expect(tempoAtBar(rampCfg, 4)).toBe(105);
    expect(tempoAtBar(rampCfg, 5)).toBe(120); // 第 4 正小节末到达目标
    expect(tempoAtBar(rampCfg, 99)).toBe(120);
  });

  it('同一小节内每拍间隔相同，且 = 60 / 该小节目标速度', () => {
    const evs = planBeats(rampCfg, 6, 0);
    for (let bar = 0; bar <= 6; bar++) {
      const inBar = evs.filter((e) => e.bar === bar);
      const want = 60 / tempoAtBar(rampCfg, bar);
      for (let i = 1; i < inBar.length; i++) {
        expect(inBar[i].time - inBar[i - 1].time).toBeCloseTo(want, 12);
      }
    }
  });

  it('变速方向反向（快→慢）同样线性', () => {
    const down = cfg({ bpm: 120, ramp: { toBpm: 60, bars: 2 } });
    expect(tempoAtBar(down, 1)).toBe(120);
    expect(tempoAtBar(down, 2)).toBe(90);
    expect(tempoAtBar(down, 3)).toBe(60);
    expect(tempoAtBar(down, 4)).toBe(60);
  });

  it('每个拍间隔逐拍现算：与按小节速度独立重算的时刻表一致', () => {
    const evs = planBeats(rampCfg, 5, 7); // 预备 + 5 正小节 = bar 0..5
    // 独立重算，不依赖 planBeats/advanceMetro
    const expected: number[] = [];
    let t = 7;
    for (let bar = 0; bar <= 5; bar++) {
      const d = 60 / tempoAtBar(rampCfg, bar);
      for (let beat = 0; beat < 4; beat++) {
        expected.push(t);
        t += d;
      }
    }
    expect(evs.map((e) => e.time)).toEqual(expected);
  });
});

describe('播放中改配置不打乱当前小节拍位', () => {
  it('小节进行中把 4 拍改成 3 拍：当前小节仍走满 4 拍，下一小节才是 3 拍', () => {
    let cur = cfg({ beatsPerBar: 4, bpm: 60 });
    let st = initialMetroState(cur, 0);
    const bars: number[] = [];
    const beatNums: number[] = [];
    for (let i = 0; i < 12; i++) {
      const ev = eventAt(st);
      bars.push(ev.bar);
      beatNums.push(ev.beat);
      if (i === 2) cur = { ...cur, beatsPerBar: 3 }; // 预备小节第 3 拍时改拍数
      st = advanceMetro(st, cur);
    }
    // 预备小节走满 4 拍（0..3），第 4 拍后才进入 bar 1；bar 1 起每小节 3 拍
    expect(bars).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3]);
    expect(beatNums).toEqual([0, 1, 2, 3, 0, 1, 2, 0, 1, 2, 0, 1]);
  });

  it('播放中改速度：下一拍间隔立即采用新速度（不重置拍位）', () => {
    let cur = cfg({ bpm: 60 }); // 1s/拍
    let st = initialMetroState(cur, 0);
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      times.push(eventAt(st).time);
      if (i === 2) cur = { ...cur, bpm: 120 }; // 第 3 拍后加速
      st = advanceMetro(st, cur);
    }
    // 前三拍 1s 间隔，之后 0.5s 间隔，拍位连续不跳
    expect(times).toEqual([0, 1, 2, 2.5, 3, 3.5]);
  });
});

describe('增量调度器（mock ctx）', () => {
  class FakeAudioContext {
    currentTime = 100;
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
  }

  it('启动后先排入预备小节，且重音标记正确', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const master = ctx.createGain();
    const handle = startMetronome(ctx, master, () => cfg({ bpm: 240 }));
    const done = handle.scheduled();
    expect(done.length).toBeGreaterThan(0);
    expect(done[0].bar).toBe(0);
    expect(done[0].beat).toBe(0);
    expect(done[0].accent).toBe(true);
    // 预排窗口（0.08 + 0.12 = 0.2s）内 240BPM（0.25s/拍）至少有 1 拍
    const accents = done.filter((e) => e.accent);
    expect(accents.every((e) => e.beat === 0)).toBe(true);
    handle.stop();
  });

  it('时刻严格单调递增', () => {
    const ctx = new FakeAudioContext() as unknown as AudioContext;
    const master = ctx.createGain();
    const handle = startMetronome(ctx, master, () => cfg({ bpm: 240 }));
    const times = handle.scheduled().map((e) => e.time);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    handle.stop();
  });
});
