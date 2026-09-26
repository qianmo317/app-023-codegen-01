// 排练节拍器：只听拍子，无谱面。Web Audio 现场合成，不加载任何音频文件。
// 关键设计：
// - 配置经 getConfig() 实时读取 → 播放中途改拍号/速度只影响「下一拍」，不打乱当前小节的拍位；
// - 每拍间隔按当时的目标速度逐拍独立计算（60/bpm），渐变过程不依赖全局平均速率；
// - 停止再开始 = 状态重置，从预备小节第 1 拍重新数（预备小节同样按首拍重音规则发声）。

export interface MetroConfig {
  beatsPerBar: number; // 2 | 3 | 4
  startBpm: number; // 起始速度（预备小节与渐变起点都用它）
  endBpm: number; // 渐变目标速度（rampBars = 0 时忽略）
  rampBars: number; // 用多少小节从 startBpm 变到 endBpm；0 = 不渐变
}

export interface MetroState {
  index: number; // 从启动起的绝对拍序号（含预备小节）
  bar: number; // 0 = 预备小节；1 起为正式小节
  beatInBar: number; // 0 基；0 = 小节第一拍（重音）
  rampBeat: number; // 预备小节结束后经过的拍数（渐变进度分子）
  time: number; // 当前拍的发声时刻（AudioContext 时轴）
}

export interface MetroBeat extends MetroState {
  bpm: number; // 本拍采用的速度（决定本拍到下一拍的间隔）
  accent: boolean; // 小节首拍为重音
}

export const BPM_MIN = 20;
export const BPM_MAX = 300;

/** 容错钳制：非法输入不进入调度 */
export function normalizeConfig(cfg: MetroConfig): MetroConfig {
  const clampBpm = (v: number) => Math.min(BPM_MAX, Math.max(BPM_MIN, Number.isFinite(v) ? v : 120));
  const beats = [2, 3, 4].includes(cfg.beatsPerBar) ? cfg.beatsPerBar : 4;
  const rampBars = Math.max(0, Math.floor(Number.isFinite(cfg.rampBars) ? cfg.rampBars : 0));
  return { beatsPerBar: beats, startBpm: clampBpm(cfg.startBpm), endBpm: clampBpm(cfg.endBpm), rampBars };
}

/**
 * 某一拍的目标速度：
 * - 预备小节（bar 0）恒为 startBpm；
 * - 渐变期间按「预备后经过的拍数 / 渐变总拍数」线性插值（BPM 线性）；
 * - 渐变结束后恒为 endBpm；rampBars = 0 时恒为 startBpm。
 */
export function tempoAt(cfg: MetroConfig, bar: number, rampBeat: number): number {
  if (bar === 0 || cfg.rampBars <= 0) return cfg.startBpm;
  const total = cfg.rampBars * cfg.beatsPerBar;
  if (rampBeat >= total) return cfg.endBpm;
  return cfg.startBpm + ((cfg.endBpm - cfg.startBpm) * rampBeat) / total;
}

export function initialState(startTime: number): MetroState {
  return { index: 0, bar: 0, beatInBar: 0, rampBeat: 0, time: startTime };
}

/** 当前拍的完整信息（发声与界面显示共用） */
export function beatAt(cfg: MetroConfig, st: MetroState): MetroBeat {
  return { ...st, bpm: tempoAt(cfg, st.bar, st.rampBeat), accent: st.beatInBar === 0 };
}

/**
 * 推进到下一拍。间隔 = 60 / 当前拍目标速度，逐拍独立重算。
 * 拍号被中途改小时：当前拍照常走完，下一拍才按新拍号归位（不重置小节与拍位）。
 */
export function advance(cfg: MetroConfig, st: MetroState): MetroState {
  const interval = 60 / tempoAt(cfg, st.bar, st.rampBeat);
  let { bar, beatInBar, rampBeat } = st;
  if (bar >= 1) rampBeat += 1; // 刚走完的是正式小节的拍 → 渐变进度 +1
  beatInBar += 1;
  if (beatInBar >= cfg.beatsPerBar) {
    beatInBar = 0;
    bar += 1;
  }
  return { index: st.index + 1, bar, beatInBar, rampBeat, time: st.time + interval };
}

// ---------- 合成击拍声（OscillatorNode + GainNode 包络 + 噪声，无采样） ----------

let clickNoiseCache: AudioBuffer | null = null;
function clickNoise(ctx: BaseAudioContext): AudioBuffer {
  if (clickNoiseCache && clickNoiseCache.sampleRate === ctx.sampleRate) return clickNoiseCache;
  const len = Math.floor(ctx.sampleRate * 0.1);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  clickNoiseCache = buf;
  return buf;
}

/**
 * 单击合成。重/轻拍三重区别：音高（1960 vs 1180 Hz）、响度（0.6 vs 0.32）、
 * 音色（重拍附加高通噪声「梆」的敲击头，轻拍为纯短音）。
 */
export function synthesizeClick(ctx: BaseAudioContext, dest: AudioNode, time: number, accent: boolean): void {
  const env = ctx.createGain();
  env.connect(dest);
  const gain0 = accent ? 0.6 : 0.32;
  const decay = accent ? 0.12 : 0.06;
  env.gain.setValueAtTime(gain0, time);
  env.gain.exponentialRampToValueAtTime(0.0001, time + decay);

  const osc = ctx.createOscillator();
  osc.type = accent ? 'triangle' : 'sine';
  osc.frequency.value = accent ? 1960 : 1180;
  osc.connect(env);
  osc.start(time);
  osc.stop(time + decay + 0.02);

  if (accent) {
    // 重拍加 30ms 高通噪声，模拟梆子/木鱼的敲击头
    const src = ctx.createBufferSource();
    src.buffer = clickNoise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 3000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);
    src.connect(f).connect(g).connect(dest);
    src.start(time, Math.random() * 0.05, 0.05);
  }
}

// ---------- Lookahead 调度器（与 audio.ts 同一模式：setInterval 填窗，发声时刻由 Web Audio 执行） ----------

export interface MetronomeHandle {
  stop(): void;
  /** 下一个待发声的拍位置（测试/调试） */
  state(): MetroState;
  /** 已排入 AudioContext 的拍（测试/调试） */
  scheduled(): MetroBeat[];
}

const LOOKAHEAD_S = 0.12;
const TIMER_MS = 25;

/**
 * 启动节拍器。getConfig 每次填窗时重新读取 → 中途改参数下一拍即生效；
 * 状态（小节/拍位/渐变进度）在调度器内部连续推进，不受配置修改影响。
 */
export function startMetronome(
  ctx: AudioContext,
  master: AudioNode,
  getConfig: () => MetroConfig,
  onBeat?: (beat: MetroBeat) => void,
): MetronomeHandle {
  let st = initialState(ctx.currentTime + 0.08);
  const done: MetroBeat[] = [];
  let stopped = false;

  const pump = () => {
    if (stopped) return;
    const cfg = normalizeConfig(getConfig());
    const now = ctx.currentTime;
    // 后台标签页定时器被节流后，跳过已错过太久的拍，重新对齐时钟（避免补放连响）
    if (st.time < now - 0.3) st = { ...st, time: now + 0.05 };
    while (st.time < now + LOOKAHEAD_S) {
      const beat = beatAt(cfg, st);
      synthesizeClick(ctx, master, beat.time, beat.accent);
      done.push(beat);
      if (onBeat) {
        const delay = Math.max((beat.time - now) * 1000, 0);
        window.setTimeout(() => {
          if (!stopped) onBeat(beat);
        }, delay);
      }
      st = advance(cfg, st);
    }
  };
  pump();
  const timer = window.setInterval(pump, TIMER_MS);
  return {
    stop() {
      stopped = true;
      window.clearInterval(timer);
    },
    state: () => st,
    scheduled: () => done.slice(),
  };
}
