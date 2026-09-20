export type WorkAnimatorStatus = "idle" | "working";
export type WorkAnimatorPreset = "shiro" | "silence_wang" | "custom";

export interface WorkAnimatorFrame {
  id: string;
  url: string;
  durationMs: number;
}

export interface WorkAnimatorState {
  preset: WorkAnimatorPreset;
  frames: WorkAnimatorFrame[];
}

export interface WorkAnimatorDisplay {
  scalePercent: number;
  offsetX: number;
  offsetY: number;
}

export interface WorkAnimatorSettings extends Record<WorkAnimatorStatus, WorkAnimatorState> {
  display: WorkAnimatorDisplay;
}

export type WorkAnimatorUpdate = Pick<WorkAnimatorState, "preset"> & {
  frames: Array<Pick<WorkAnimatorFrame, "id" | "durationMs">>;
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
    idle: { preset: "shiro", frames: presetFrames("idle", "shiro") },
    working: { preset: "shiro", frames: presetFrames("working", "shiro") },
    display: { ...WORK_ANIMATOR_DEFAULT_DISPLAY },
  };
}

export function isPresetFrame(status: WorkAnimatorStatus, preset: Exclude<WorkAnimatorPreset, "custom">, id: string): boolean {
  return presetFrames(status, preset).some((frame) => frame.id === id);
}
