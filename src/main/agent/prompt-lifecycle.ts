import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";

type PromptImages = NonNullable<Parameters<AgentSession["steer"]>[1]>;
type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

interface PendingSteer {
  text: string;
  images: PromptImages;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class PromptLifecycle {
  private operation: Promise<void> | undefined;
  private operationOwner: object | undefined;
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
    const owner = session.isStreaming ? undefined : this.beginOperation(session);
    try {
      const operation = session.prompt(text, this.buildPromptOptions(session, images, owner));
      // Preflight may run synchronously and hand ownership to a replayed prompt.
      if (owner && this.operationOwner === owner) this.operation = operation;
      await operation;
    } catch (error) {
      if (owner && this.operationOwner === owner) {
        for (const pending of this.pendingSteering.splice(0)) pending.reject(error);
      }
      throw error;
    } finally {
      if (owner) this.finishOperation(session, owner);
    }
  }

  async continueAfterError(session: AgentSession, instruction: string): Promise<void> {
    if (this.stopRequested || this.isActive(session)) throw new Error("Wait for the current agent run to finish before continuing.");
    const owner = this.beginOperation(session);
    try {
      const operation = session.sendCustomMessage({
        customType: "pi-ecode.provider-recovery", content: instruction, display: false,
      }, { triggerTurn: true });
      this.operation = operation;
      this.starting = false;
      await operation;
    } finally {
      this.finishOperation(session, owner);
    }
  }

  async stop(session: AgentSession): Promise<void> {
    this.stopRequested = true;
    session.clearQueue();
    for (const pending of this.pendingSteering.splice(0)) pending.resolve();
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
    this.operationOwner = undefined;
    this.starting = false;
    this.stopRequested = false;
    this.startedAt = null;
    for (const pending of this.pendingSteering.splice(0)) pending.resolve();
  }

  private beginOperation(session: AgentSession): object {
    const owner = {};
    this.operationOwner = owner;
    this.starting = true;
    this.startedAt = Date.now();
    this.onStateChanged(session);
    return owner;
  }

  private finishOperation(session: AgentSession, owner: object): void {
    if (this.operationOwner !== owner) return;
    this.operationOwner = undefined;
    this.operation = undefined;
    this.starting = false;
    this.startedAt = null;
    this.onStateChanged(session);
  }

  private buildPromptOptions(session: AgentSession, images: PromptImages, owner: object | undefined): PromptOptions {
    return {
      ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(owner ? { preflightResult: (disposition) => this.preflightFinished(session, owner, disposition) } : {}),
    };
  }

  private preflightFinished(session: AgentSession, owner: object, disposition: PromptDisposition): void {
    if (this.operationOwner !== owner) return;
    this.starting = false;
    const pendingSteering = this.pendingSteering.splice(0);
    if (disposition !== "started") this.finishOperation(session, owner);
    if (this.stopRequested) {
      for (const pending of pendingSteering) pending.resolve();
      // A queued prompt may have entered the SDK queue after stop cleared it.
      session.clearQueue();
      if (disposition === "started") queueMicrotask(() => void session.abort());
      return;
    }
    for (const pending of pendingSteering) {
      const operation = disposition === "handled"
        ? this.prompt(session, pending.text, pending.images)
        : session.steer(pending.text, pending.images);
      void operation.then(pending.resolve, pending.reject);
    }
  }
}
