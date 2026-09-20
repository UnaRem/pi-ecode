import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { applyWorkAnimatorTiming, type WorkAnimatorCurve, type WorkAnimatorFrame, type WorkAnimatorTiming } from "../../../shared/work-animator";
import { useI18n } from "../../i18n/i18n";

const PRESETS: Array<{ key: "linear" | "easeIn" | "easeOut" | "easeInOut"; curve: WorkAnimatorCurve }> = [
  { key: "linear", curve: { x1: 0, y1: 0, x2: 1, y2: 1 } },
  { key: "easeIn", curve: { x1: 0.42, y1: 0, x2: 1, y2: 1 } },
  { key: "easeOut", curve: { x1: 0, y1: 0, x2: 0.58, y2: 1 } },
  { key: "easeInOut", curve: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } },
];
const SIZE = 160;
const PADDING = 14;
const SPAN = SIZE - PADDING * 2;

interface Props {
  frames: WorkAnimatorFrame[];
  timing: WorkAnimatorTiming;
  loading: boolean;
  onApply: (timing: WorkAnimatorTiming) => void;
}

function sameTiming(left: WorkAnimatorTiming, right: WorkAnimatorTiming): boolean {
  return left.cycleDurationMs === right.cycleDurationMs
    && Object.keys(left.curve).every((key) => left.curve[key as keyof WorkAnimatorCurve] === right.curve[key as keyof WorkAnimatorCurve]);
}

function CurvePlaybackPreview({ frames, timing }: Pick<Props, "frames" | "timing">) {
  const [index, setIndex] = useState(0);
  const timedFrames = applyWorkAnimatorTiming(frames, timing);
  useEffect(() => {
    setIndex(0);
    if (timedFrames.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let nextIndex = 0;
    let timer: ReturnType<typeof setTimeout>;
    const advance = (): void => {
      timer = setTimeout(() => {
        nextIndex = (nextIndex + 1) % timedFrames.length;
        setIndex(nextIndex);
        advance();
      }, timedFrames[nextIndex]!.durationMs);
    };
    advance();
    return () => clearTimeout(timer);
  }, [frames, timing]);
  const frame = timedFrames[index] ?? timedFrames[0];
  return <div className="work-animator-curve-preview" aria-hidden="true">{frame && <img src={frame.url} alt="" />}</div>;
}

export function WorkAnimatorCurveEditor({ frames, timing, loading, onApply }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(timing);
  const graphRef = useRef<SVGSVGElement>(null);
  useEffect(() => setDraft(timing), [timing]);
  const durations = applyWorkAnimatorTiming(frames, draft).map((frame) => frame.durationMs);
  const point = (x: number, y: number): [number, number] => [PADDING + x * SPAN, SIZE - PADDING - y * SPAN];
  const [startX, startY] = point(0, 0);
  const [endX, endY] = point(1, 1);
  const [p1x, p1y] = point(draft.curve.x1, draft.curve.y1);
  const [p2x, p2y] = point(draft.curve.x2, draft.curve.y2);
  const path = `M ${startX} ${startY} C ${p1x} ${p1y}, ${p2x} ${p2y}, ${endX} ${endY}`;

  const setPoint = (which: 1 | 2, clientX: number, clientY: number): void => {
    const bounds = graphRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = Math.max(0, Math.min(1, (clientX - bounds.left - PADDING) / SPAN));
    const y = Math.max(0, Math.min(1, (bounds.bottom - clientY - PADDING) / SPAN));
    setDraft((current) => ({ ...current, curve: { ...current.curve, [`x${which}`]: Number(x.toFixed(2)), [`y${which}`]: Number(y.toFixed(2)) } }));
  };
  const drag = (which: 1 | 2, event: PointerEvent<SVGCircleElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setPoint(which, event.clientX, event.clientY);
  };
  const keyboardMove = (which: 1 | 2, event: KeyboardEvent<SVGCircleElement>): void => {
    const changes: Record<string, [number, number]> = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, 0.01], ArrowDown: [0, -0.01] };
    const change = changes[event.key];
    if (!change) return;
    event.preventDefault();
    setDraft((current) => ({ ...current, curve: {
      ...current.curve,
      [`x${which}`]: Math.max(0, Math.min(1, Number((current.curve[`x${which}` as "x1"] + change[0]).toFixed(2)))),
      [`y${which}`]: Math.max(0, Math.min(1, Number((current.curve[`y${which}` as "y1"] + change[1]).toFixed(2)))),
    } }));
  };

  return <div className="work-animator-curve-editor">
    <div className="work-animator-curve-presets">
      {PRESETS.map((preset) => <button key={preset.key} disabled={loading} onClick={() => setDraft((current) => ({ ...current, curve: { ...preset.curve } }))}>{t(`settings.app.animator.curve.${preset.key}`)}</button>)}
    </div>
    <div className="work-animator-curve-body">
      <svg ref={graphRef} className="work-animator-curve-graph" viewBox={`0 0 ${SIZE} ${SIZE}`} aria-label={t("settings.app.animator.curve.graph")}>
        <line x1={startX} y1={startY} x2={p1x} y2={p1y} />
        <line x1={endX} y1={endY} x2={p2x} y2={p2y} />
        <path d={path} />
        {([[1, p1x, p1y], [2, p2x, p2y]] as const).map(([which, x, y]) => <circle key={which} cx={x} cy={y} r="6" role="slider" tabIndex={0}
          aria-label={t("settings.app.animator.curve.point", { point: which })} aria-valuemin={0} aria-valuemax={1} aria-valuenow={draft.curve[`x${which}`]} aria-valuetext={`${draft.curve[`x${which}`]}, ${draft.curve[`y${which}`]}`}
          onPointerDown={(event) => drag(which, event)} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) setPoint(which, event.clientX, event.clientY); }}
          onKeyDown={(event) => keyboardMove(which, event)} />)}
      </svg>
      <div className="work-animator-curve-fields">
        <CurvePlaybackPreview frames={frames} timing={draft} />
        <label><span>{t("settings.app.animator.cycle")}</span><input type="number" min={frames.length * 16} max={1000000} value={draft.cycleDurationMs} disabled={loading}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (Number.isInteger(value) && value >= frames.length * 16 && value <= 1_000_000) setDraft((current) => ({ ...current, cycleDurationMs: value }));
          }} /><span>ms</span></label>
        <div className="work-animator-curve-points">
          {(["x1", "y1", "x2", "y2"] as const).map((key) => <label key={key}><span>{key}</span><input type="number" min={0} max={1} step={0.01} value={draft.curve[key]} disabled={loading}
            onChange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value) && value >= 0 && value <= 1) setDraft((current) => ({ ...current, curve: { ...current.curve, [key]: value } }));
            }} /></label>)}
        </div>
        <code>cubic-bezier({draft.curve.x1}, {draft.curve.y1}, {draft.curve.x2}, {draft.curve.y2})</code>
        <div className="work-animator-calculated">{durations.map((duration, index) => <span key={index}>{index + 1}: {duration}ms</span>)}</div>
        <button className="work-animator-curve-apply" disabled={loading || sameTiming(draft, timing) || draft.cycleDurationMs < frames.length * 16 || draft.cycleDurationMs > 1000000}
          onClick={() => onApply(draft)}>{t("settings.app.animator.curve.apply")}</button>
      </div>
    </div>
  </div>;
}
