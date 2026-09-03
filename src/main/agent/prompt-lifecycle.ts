import type { AgentSession } from "@earendil-works/pi-coding-agent";

type PromptImages = NonNullable<Parameters<AgentSession["steer"]>[1]>;

interface PendingSteer {
  text: string;
  images: PromptImages;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class PromptLifecycle {
  private operation: Promise<void> | undefined;
  private starting = false;
  private stopRequested = false;
  private pendingSteering: PendingSteer[] = [];
  private startedAt: number | null = null;

  constructor(private readonly onStateChanged: (session: AgentSession) => void) {}

  isActive(session: AgentSession): boolean {
    return Boolean(this.starting || this.operation || session.isStreaming);
  }

  get workingStartedAt(): number | null {
    return this.startedAt;
  }

  async prompt(session: AgentSession, text: string, images: PromptImages): Promise<void> {
    if (this.stopRequested) throw new Error("The agent is stopping. Wait for it to become idle before sending another message.");
    if (this.starting) {
      await new Promise<void>((resolve, reject) => this.pendingSteering.push({ text, images, resolve, reject }));
      return;
    }

    const isStarting = !session.isStreaming;
    if (isStarting) {
      this.starting = true;
      this.startedAt = Date.now();
      this.onStateChanged(session);
    }
    const operation = session.prompt(text, {
      ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(isStarting ? { preflightResult: (accepted: boolean) => this.preflightFinished(session, accepted) } : {}),
    });
    if (isStarting) this.operation = operation;
    try {
      await operation;
    } finally {
      if (this.operation === operation) {
        this.starting = false;
        this.operation = undefined;
        this.startedAt = null;
        this.onStateChanged(session);
      }
    }
  }

  async stop(session: AgentSession): Promise<void> {
    this.stopRequested = true;
    session.clearQueue();
    try {
      if (this.operation && !session.isStreaming) await this.operation.catch(() => undefined);
      else await session.abort();
    } finally {
      this.stopRequested = false;
      this.onStateChanged(session);
    }
  }

  reset(): void {
    this.operation = undefined;
    this.starting = false;
    this.stopRequested = false;
    this.startedAt = null;
    for (const pending of this.pendingSteering.splice(0)) pending.resolve();
  }

  private preflightFinished(session: AgentSession, accepted: boolean): void {
    this.starting = false;
    const pendingSteering = this.pendingSteering.splice(0);
    if (accepted && !this.stopRequested) {
      for (const pending of pendingSteering) {
        void session.steer(pending.text, pending.images).then(pending.resolve, pending.reject);
      }
    } else if (this.stopRequested) {
      for (const pending of pendingSteering) pending.resolve();
    } else {
      const error = new Error("The active prompt was rejected before the queued message could be delivered.");
      for (const pending of pendingSteering) pending.reject(error);
    }
    if (accepted && this.stopRequested) queueMicrotask(() => void session.abort());
  }
}
