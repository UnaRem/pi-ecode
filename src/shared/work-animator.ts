export type WorkAnimatorStatus = "idle" | "working";
export type WorkAnimatorPreset = "shiro" | "silence_wang" | "custom";

export interface WorkAnimatorFrame {
  id: string;
  url: string;
  durationMs: number;
}

export interface WorkAnimatorCurve {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WorkAnimatorTiming {
  cycleDurationMs: number;
  curve: WorkAnimatorCurve;
}

export interface WorkAnimatorState {
  preset: WorkAnimatorPreset;
  frames: WorkAnimatorFrame[];
  timing: WorkAnimatorTiming;
}

export interface WorkAnimatorDisplay {
  scalePercent: number;
  offsetX: number;
  offsetY: number;
}

export interface WorkAnimatorSettings extends Record<WorkAnimatorStatus, WorkAnimatorState> {
  display: WorkAnimatorDisplay;
}

export type WorkAnimatorUpdate = Pick<WorkAnimatorState, "preset" | "timing"> & {
  frames: Array<Pick<WorkAnimatorFrame, "id">>;
};

export const WORK_ANIMATOR_DEFAULT_DURATION: Record<WorkAnimatorStatus, number> = {
  idle: 650,
  working: 220,
};

export const WORK_ANIMATOR_DEFAULT_DISPLAY: WorkAnimatorDisplay = {
  scalePercent: 100,
  offsetX: 0,
  offsetY: 0,
};

export const WORK_ANIMATOR_LINEAR_CURVE: WorkAnimatorCurve = { x1: 0, y1: 0, x2: 1, y2: 1 };
export const WORK_ANIMATOR_MIN_FRAME_MS = 16;
export const WORK_ANIMATOR_MAX_CYCLE_MS = 1_000_000;

export function defaultWorkAnimatorTiming(status: WorkAnimatorStatus, frameCount: number): WorkAnimatorTiming {
  return {
    cycleDurationMs: WORK_ANIMATOR_DEFAULT_DURATION[status] * frameCount,
    curve: { ...WORK_ANIMATOR_LINEAR_CURVE },
  };
}

function bezierCoordinate(position: number, first: number, second: number): number {
  const inverse = 1 - position;
  return 3 * inverse * inverse * position * first + 3 * inverse * position * position * second + position ** 3;
}

// CSS easing maps time (x) to progress (y); equal-progress frame boundaries need the inverse y → x lookup.
function timeAtProgress(progress: number, curve: WorkAnimatorCurve): number {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const position = (low + high) / 2;
    if (bezierCoordinate(position, curve.y1, curve.y2) < progress) low = position;
    else high = position;
  }
  const position = (low + high) / 2;
  return bezierCoordinate(position, curve.x1, curve.x2);
}

export function calculateFrameDurations(frameCount: number, timing: WorkAnimatorTiming): number[] {
  if (frameCount <= 0) return [];
  const minimumTotal = frameCount * WORK_ANIMATOR_MIN_FRAME_MS;
  const distributable = Math.max(0, timing.cycleDurationMs - minimumTotal);
  const boundaries = Array.from({ length: frameCount + 1 }, (_, index) =>
    index === 0 ? 0 : index === frameCount ? 1 : timeAtProgress(index / frameCount, timing.curve),
  );
  const rawExtras = boundaries.slice(1).map((boundary, index) => (boundary - boundaries[index]!) * distributable);
  const durations = rawExtras.map((value) => WORK_ANIMATOR_MIN_FRAME_MS + Math.floor(value));
  let remainder = timing.cycleDurationMs - durations.reduce((sum, value) => sum + value, 0);
  const order = rawExtras.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (let index = 0; index < remainder; index += 1) durations[order[index % order.length]!.index]! += 1;
  return durations;
}

export function applyWorkAnimatorTiming(frames: WorkAnimatorFrame[], timing: WorkAnimatorTiming): WorkAnimatorFrame[] {
  const durations = calculateFrameDurations(frames.length, timing);
  return frames.map((frame, index) => ({ ...frame, durationMs: durations[index]! }));
}

// The supplied preset deliberately retains its on-disk spelling and idle3.png filename.
const PRESET_FILES: Record<Exclude<WorkAnimatorPreset, "custom">, Record<WorkAnimatorStatus, string[]>> = {
  shiro: {
    idle: Array.from({ length: 6 }, (_, index) => `idle_${index + 1}.png`),
    working: Array.from({ length: 6 }, (_, index) => `working_${index + 1}.png`),
  },
  silence_wang: {
    idle: ["idle_1.png", "idle_2.png", "idle3.png", "idle_4.png"],
    working: Array.from({ length: 12 }, (_, index) => `working_${index + 1}.png`),
  },
};

export function presetFrames(status: WorkAnimatorStatus, preset: Exclude<WorkAnimatorPreset, "custom">): WorkAnimatorFrame[] {
  const directory = preset === "silence_wang" ? "slience_wang" : preset;
  return PRESET_FILES[preset][status].map((filename) => {
    const id = `work_animator/${directory}/${filename}`;
    return { id, url: `./${id}`, durationMs: WORK_ANIMATOR_DEFAULT_DURATION[status] };
  });
}

export function defaultWorkAnimator(): WorkAnimatorSettings {
  return {
    idle: { preset: "shiro", frames: presetFrames("idle", "shiro"), timing: defaultWorkAnimatorTiming("idle", 6) },
    working: { preset: "shiro", frames: presetFrames("working", "shiro"), timing: defaultWorkAnimatorTiming("working", 6) },
    display: { ...WORK_ANIMATOR_DEFAULT_DISPLAY },
  };
}

export function isPresetFrame(status: WorkAnimatorStatus, preset: Exclude<WorkAnimatorPreset, "custom">, id: string): boolean {
  return presetFrames(status, preset).some((frame) => frame.id === id);
}
