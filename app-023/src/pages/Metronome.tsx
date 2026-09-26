// 节拍器 /metronome —— 只听拍子：每小节 2/3/4 拍可选，首拍重音，预备一小节，
// 支持跨小节线性变速。播放中改速度/拍数不打断当前小节；停止后再开始从头数。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startMetronome,
  tempoAtBar,
  type MetronomeConfig,
  type MetronomeHandle,
  type MetroEvent,
} from '../lib/metronome';

const MIN_BPM = 30;
const MAX_BPM = 240;

function clampBpm(v: number): number {
  if (Number.isNaN(v)) return MIN_BPM;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(v)));
}

export function Metronome() {
  const [beatsPerBar, setBeatsPerBar] = useState<2 | 3 | 4>(4);
  const [bpm, setBpm] = useState(90);
  const [rampOn, setRampOn] = useState(false);
  const [rampToBpm, setRampToBpm] = useState(140);
  const [rampBars, setRampBars] = useState(8);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState<MetroEvent | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const handleRef = useRef<MetronomeHandle | null>(null);

  // 配置 ref：调度器每拍读取，保证播放中修改即时生效（速度下一拍、拍数下一小节）
  const cfgRef = useRef<MetronomeConfig>({ beatsPerBar, bpm, ramp: null });
  cfgRef.current = {
    beatsPerBar,
    bpm,
    ramp: rampOn && rampToBpm !== bpm ? { toBpm: clampBpm(rampToBpm), bars: Math.max(1, Math.round(rampBars)) } : null,
  };

  const onBeat = useCallback((ev: MetroEvent) => setPos(ev), []);

  const start = useCallback(() => {
    handleRef.current?.stop();
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      ctxRef.current = ctx;
      (window as unknown as { __audioCtx?: AudioContext }).__audioCtx = ctx;
    }
    const ctx = ctxRef.current;
    ctx
      .resume()
      .catch(() => undefined)
      .then(() => {
        // 每次开始都重新建状态——从预备小节第 1 拍从头数
        setPos(null);
        const handle = startMetronome(ctx, ctx.destination, () => cfgRef.current, onBeat);
        handleRef.current = handle;
        setPlaying(true);
        // 调试钩子：E2E 断言调度
        (window as unknown as { __metroScheduled?: () => MetroEvent[] }).__metroScheduled = () => handle.scheduled();
      });
  }, [onBeat]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    setPlaying(false);
    setPos(null); // 停止即清零，再开始从预备小节重来
  }, []);

  useEffect(() => () => handleRef.current?.stop(), []);

  // 空格：开始/停止
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      playing ? stop() : start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, start, stop]);

  const curTempo = pos ? tempoAtBar(cfgRef.current, pos.bar) : bpm;
  const isCountIn = pos?.bar === 0;

  return (
    <div className="page metro-page" data-testid="metro-page">
      <h1>节拍器</h1>
      <p className="dim">每小节第一拍为重音（低沉的「咚」），其余为轻音（清脆的「哒」）；开始先空数一小节预备。</p>

      <section className="metro-panel">
        <div className="metro-display" data-testid="metro-display">
          {pos ? (
            <>
              <div className="metro-pos" data-testid="metro-pos">
                {isCountIn ? '预备小节' : `第 ${pos.bar} 小节`}
                <span className="metro-beat">第 {pos.beat + 1} 拍</span>
              </div>
              <div className="metro-dots" data-testid="metro-dots">
                {Array.from({ length: pos.beats }, (_, i) => (
                  <span key={i} className={`metro-dot ${i === pos.beat ? (pos.accent ? 'on-accent' : 'on') : ''}`}>
                    {i + 1}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="metro-pos dim" data-testid="metro-pos">
              已停止
            </div>
          )}
          <div className="metro-tempo dim" data-testid="metro-tempo">
            {playing ? `当前速度 ${curTempo.toFixed(1)} BPM` : `${bpm} BPM`}
          </div>
        </div>

        <div className="metro-controls">
          <div className="metro-row">
            <span className="metro-label">每小节拍数</span>
            <div className="metro-seg" data-testid="metro-beats">
              {([2, 3, 4] as const).map((n) => (
                <button
                  key={n}
                  className={`btn-sm ${beatsPerBar === n ? 'on' : ''}`}
                  data-testid={`metro-beats-${n}`}
                  onClick={() => setBeatsPerBar(n)}
                  title={playing ? '下一小节生效，不打乱当前小节' : ''}
                >
                  {n} 拍
                </button>
              ))}
            </div>
            {playing && <span className="dim">播放中改动下一小节生效</span>}
          </div>

          <div className="metro-row">
            <span className="metro-label">速度</span>
            <div className="bpm-box">
              <button data-testid="metro-bpm-down" onClick={() => setBpm((v) => clampBpm(v - 2))}>
                −
              </button>
              <input
                className="metro-bpm-input"
                data-testid="metro-bpm"
                type="number"
                min={MIN_BPM}
                max={MAX_BPM}
                value={bpm}
                onChange={(e) => setBpm(clampBpm(Number(e.target.value)))}
              />
              <span className="dim">BPM</span>
              <button data-testid="metro-bpm-up" onClick={() => setBpm((v) => clampBpm(v + 2))}>
                +
              </button>
            </div>
          </div>

          <div className="metro-row">
            <label className="metro-label">
              <input type="checkbox" data-testid="metro-ramp-on" checked={rampOn} onChange={(e) => setRampOn(e.target.checked)} />
              渐变速
            </label>
            {rampOn && (
              <div className="metro-ramp">
                <span className="dim">在</span>
                <input
                  className="metro-num-input"
                  data-testid="metro-ramp-bars"
                  type="number"
                  min={1}
                  max={500}
                  value={rampBars}
                  onChange={(e) => setRampBars(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                />
                <span className="dim">小节内变到</span>
                <input
                  className="metro-num-input"
                  data-testid="metro-ramp-to"
                  type="number"
                  min={MIN_BPM}
                  max={MAX_BPM}
                  value={rampToBpm}
                  onChange={(e) => setRampToBpm(clampBpm(Number(e.target.value)))}
                />
                <span className="dim">BPM（每拍间隔按当时速度逐拍计算）</span>
              </div>
            )}
          </div>

          <div className="metro-row">
            <button className="btn primary metro-start" data-testid="metro-toggle" onClick={playing ? stop : start}>
              {playing ? '■ 停止' : '▶ 开始（先数一小节预备）'}
            </button>
            <span className="dim">空格也可开始/停止</span>
          </div>
        </div>
      </section>
    </div>
  );
}
