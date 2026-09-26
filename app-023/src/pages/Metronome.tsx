// 节拍器 /metronome —— 排练用纯拍点：预备一小节、首拍重音、速度可渐变
import { useEffect, useRef, useState } from 'react';
import {
  BPM_MAX,
  BPM_MIN,
  normalizeConfig,
  startMetronome,
  type MetroBeat,
  type MetroConfig,
  type MetronomeHandle,
} from '../lib/metronome';

interface Display {
  bar: number; // 0 = 预备小节
  beatInBar: number; // 0 基
  accent: boolean;
  bpm: number;
}

export function Metronome() {
  const [beatsPerBar, setBeatsPerBar] = useState(4);
  const [startBpm, setStartBpm] = useState(96);
  const [endBpm, setEndBpm] = useState(144);
  const [rampBars, setRampBars] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [display, setDisplay] = useState<Display | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const handleRef = useRef<MetronomeHandle | null>(null);
  // 配置经 ref 实时供调度器读取：播放中改动只影响下一拍，不重启、不打乱拍位
  const cfgRef = useRef<MetroConfig>({ beatsPerBar: 4, startBpm: 96, endBpm: 144, rampBars: 0 });
  cfgRef.current = normalizeConfig({ beatsPerBar, startBpm, endBpm, rampBars });

  const ensureCtx = (): { ctx: AudioContext; master: GainNode } => {
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      masterRef.current = master;
    }
    return { ctx: ctxRef.current, master: masterRef.current! };
  };

  const stop = () => {
    handleRef.current?.stop();
    handleRef.current = null;
    setPlaying(false);
    setDisplay(null);
  };

  const start = () => {
    handleRef.current?.stop();
    const { ctx, master } = ensureCtx();
    // 等上下文真正运行后再排程（suspended 时 currentTime 冻结）
    ctx
      .resume()
      .catch(() => undefined)
      .then(() => {
        const onBeat = (b: MetroBeat) =>
          setDisplay({ bar: b.bar, beatInBar: b.beatInBar, accent: b.accent, bpm: b.bpm });
        handleRef.current = startMetronome(ctx, master, () => cfgRef.current, onBeat);
        setPlaying(true);
        // 调试钩子：E2E 用它断言逐拍间隔
        (window as unknown as { __metro?: () => MetroBeat[] }).__metro = () =>
          handleRef.current?.scheduled() ?? [];
      });
  };

  useEffect(() => () => handleRef.current?.stop(), []);

  const rampOn = rampBars > 0;
  const barLabel = display ? (display.bar === 0 ? '预备' : `第 ${display.bar} 小节`) : '—';
  const beatLabel = display ? `第 ${display.beatInBar + 1} 拍` : '—';

  return (
    <div className="page" data-testid="metronome-page">
      <h1>排练节拍器</h1>
      <p className="dim">
        每次开始先空数一小节作预备（同样首拍重音）；停下再开始从头数。播放中改拍号或速度，当前小节的拍位不受影响，下一拍生效。
      </p>

      <div className="metro-display" data-testid="metro-display">
        <div className="metro-position" data-testid="metro-position">
          <span className="metro-bar" data-testid="metro-bar-label">{barLabel}</span>
          <span className="metro-beat" data-testid="metro-beat-label">{beatLabel}</span>
        </div>
        <div className="metro-dots" data-testid="metro-dots">
          {Array.from({ length: beatsPerBar }, (_, i) => {
            const on = display != null && display.beatInBar === i;
            const cls = `metro-dot${i === 0 ? ' accent' : ''}${on ? ' on' : ''}`;
            return <span key={i} className={cls} data-testid={`metro-dot-${i}`} />;
          })}
        </div>
        <div className="metro-bpm-now" data-testid="metro-bpm-now">
          {display ? `当前速度 ${display.bpm.toFixed(1)} BPM` : '未在走拍'}
        </div>
      </div>

      <h2>拍号（每小节拍数）</h2>
      <div className="metro-row" data-testid="metro-beats">
        {[2, 3, 4].map((n) => (
          <button
            key={n}
            className={`btn-sm${beatsPerBar === n ? ' on' : ''}`}
            data-testid={`metro-beats-${n}`}
            onClick={() => setBeatsPerBar(n)}
          >
            {n} 拍
          </button>
        ))}
      </div>

      <h2>速度</h2>
      <div className="metro-row">
        <label className="metro-field">
          起始速度（BPM）
          <input
            type="number"
            data-testid="metro-start-bpm"
            min={BPM_MIN}
            max={BPM_MAX}
            value={startBpm}
            onChange={(e) => setStartBpm(Number(e.target.value))}
          />
        </label>
        <label className="metro-field">
          渐变小节数（0 = 不渐变）
          <input
            type="number"
            data-testid="metro-ramp-bars"
            min={0}
            max={999}
            value={rampBars}
            onChange={(e) => setRampBars(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          />
        </label>
        <label className="metro-field">
          目标速度（BPM）
          <input
            type="number"
            data-testid="metro-end-bpm"
            min={BPM_MIN}
            max={BPM_MAX}
            value={endBpm}
            disabled={!rampOn}
            onChange={(e) => setEndBpm(Number(e.target.value))}
          />
        </label>
      </div>
      {rampOn && (
        <p className="dim" data-testid="metro-ramp-hint">
          预备小节后，用 {rampBars} 个小节从 {startBpm} BPM 均匀变到 {endBpm} BPM，每一拍的间隔按当时的目标速度逐拍计算。
        </p>
      )}

      <div className="metro-row">
        <button
          className={`btn primary metro-toggle`}
          data-testid="metro-toggle"
          onClick={() => (playing ? stop() : start())}
        >
          {playing ? '停止' : '开始'}
        </button>
      </div>
    </div>
  );
}
