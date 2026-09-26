// 节拍器：纯函数节拍计算 + Web Audio 现场合成 + 增量 lookahead 调度
// 与 audio.ts 相同的调度纪律：setInterval 只填窗口，发声时刻由 AudioContext 时间轴执行。
// 关键差异：不预排整曲，而是「逐拍增量推进」——每推进一拍才读取一次当前配置，
// 因此播放中改速度/改每小节拍数即时生效且不打乱当前小节的拍位。

export interface MetronomeConfig {
  beatsPerBar: 2 | 3 | 4;
  bpm: number; // 起始速度
  /** 速度渐变：用 bars 个小节从 bpm 线性变到 toBpm；null = 恒速 */
  ramp: { toBpm: number; bars: number } | null;
}

export interface MetroEvent {
  time: number; // ctx 时轴上的发声时刻
  bar: number; // 0 = 预备小节（空数），1 起为正小节
  beat: number; // 0-based，0 为重音
  beats: number; // 本小节拍数（小节边界锁定）
  accent: boolean;
}

/** 推进器状态：bar/beat 为下一拍要发声的位置，nextTime 为其时刻 */
export interface MetroState {
  bar: number;
  beat: number;
  beatsThisBar: number; // 本小节拍数（小节开始时锁定，中途改配置不影响本小节）
  nextTime: number;
}

export const COUNT_IN_BAR = 0; // 预备小节的 bar 编号

/**
 * 某小节的目标速度。预备小节（bar 0）恒用起始速度；
 * 渐变从第 1 个正小节开始，第 ramp.bars 个正小节结束后到达目标速度。
 */
export function tempoAtBar(cfg: MetronomeConfig, bar: number): number {
  const real = bar - 1; // 正小节从 0 计
  if (real < 0 || !cfg.ramp || cfg.ramp.bars <= 0) return cfg.bpm;
  const t = Math.min(real / cfg.ramp.bars, 1);
  return cfg.bpm + (cfg.ramp.toBpm - cfg.bpm) * t;
}

/** 初始状态：从预备小节第 1 拍开始 */
export function initialMetroState(cfg: MetronomeConfig, startTime: number): MetroState {
  return { bar: COUNT_IN_BAR, beat: 0, beatsThisBar: cfg.beatsPerBar, nextTime: startTime };
}

/**
 * 推进一拍（纯函数）：返回下一状态。
 * 拍间隔按「当前小节当时的目标速度」逐拍现算：interval = 60 / tempoAtBar(bar)。
 * beatsPerBar 只在小节边界读取——本小节内改拍数不打乱当前拍位，下一小节生效。
 */
export function advanceMetro(state: MetroState, cfg: MetronomeConfig): MetroState {
  const interval = 60 / tempoAtBar(cfg, state.bar);
  let { bar, beat, beatsThisBar } = state;
  beat += 1;
  if (beat >= beatsThisBar) {
    bar += 1;
    beat = 0;
    beatsThisBar = cfg.beatsPerBar; // 小节边界才采用新拍数
  }
  return { bar, beat, beatsThisBar, nextTime: state.nextTime + interval };
}

/** 由状态得到当前待发声事件 */
export function eventAt(state: MetroState): MetroEvent {
  return {
    time: state.nextTime,
    bar: state.bar,
    beat: state.beat,
    beats: state.beatsThisBar,
    accent: state.beat === 0,
  };
}

/**
 * 展开事件表（测试与校验用）：预备小节 + realBars 个正小节。
 * 与调度器共用同一推进器，保证「计划」与「实播」一致。
 */
export function planBeats(cfg: MetronomeConfig, realBars: number, startTime: number): MetroEvent[] {
  const total = cfg.beatsPerBar * (realBars + 1); // +1 = 预备小节
  const out: MetroEvent[] = [];
  let st = initialMetroState(cfg, startTime);
  for (let i = 0; i < total; i++) {
    out.push(eventAt(st));
    st = advanceMetro(st, cfg);
  }
  return out;
}

// ---------- 合成音（无采样：OscillatorNode + GainNode 包络） ----------

/**
 * 击拍声：重音 = 低频下沉「咚」（响、长、低），轻音 = 高频短「哒」（轻、短、高），
 * 频率/响度/时长三重差异，确保两种声音明确可辨。
 */
export function synthesizeClick(ctx: BaseAudioContext, dest: AudioNode, time: number, accent: boolean): void {
  const env = ctx.createGain();
  env.connect(dest);
  const osc = ctx.createOscillator();
  osc.connect(env);
  if (accent) {
    // 重音：330→110Hz 正弦下沉，响度大、衰减长
    env.gain.setValueAtTime(0.9, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.18);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(330, time);
    osc.frequency.exponentialRampToValueAtTime(110, time + 0.12);
    osc.start(time);
    osc.stop(time + 0.2);
  } else {
    // 轻音：1568Hz 三角波短促 blip，响度小、衰减短
    env.gain.setValueAtTime(0.45, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1568, time);
    osc.start(time);
    osc.stop(time + 0.08);
  }
}

// ---------- 增量 lookahead 调度器 ----------

export interface MetronomeHandle {
  stop(): void;
  /** 已排入的事件（测试/调试钩子） */
  scheduled(): MetroEvent[];
}

const LOOKAHEAD_S = 0.12;
const TIMER_MS = 25;

/**
 * 启动节拍器：从预备小节开始无限走下去，直到 stop()。
 * getCfg 每拍都会被重新调用——播放中修改配置即时生效：
 * 速度变化下一拍生效；每小节拍数变化下一小节生效（当前小节拍位不受扰）。
 */
export function startMetronome(
  ctx: AudioContext,
  dest: AudioNode,
  getCfg: () => MetronomeConfig,
  onBeat?: (ev: MetroEvent) => void,
): MetronomeHandle {
  let state = initialMetroState(getCfg(), ctx.currentTime + 0.08);
  const done: MetroEvent[] = [];
  let stopped = false;

  const pump = () => {
    if (stopped) return;
    const now = ctx.currentTime;
    while (state.nextTime < now + LOOKAHEAD_S) {
      const ev = eventAt(state);
      synthesizeClick(ctx, dest, ev.time, ev.accent);
      done.push(ev);
      const delay = Math.max((ev.time - now) * 1000, 0);
      window.setTimeout(() => onBeat && onBeat(ev), delay);
      state = advanceMetro(state, getCfg());
    }
  };
  pump();
  const timer = window.setInterval(pump, TIMER_MS);
  return {
    stop() {
      stopped = true;
      window.clearInterval(timer);
    },
    scheduled: () => done.slice(),
  };
}
