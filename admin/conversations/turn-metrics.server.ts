import type { ModelUsageUpdate } from "../usage/contracts";
import { performance } from "node:perf_hooks";

/** Bounded, content-free measurements of one advisor turn; no transcript or tool args. */
export class TurnMetrics {
  private readonly started = performance.now();
  private readonly attempts = new Map<string, { started: number; elapsed?: number; usage: ModelUsageUpdate }>();
  private readonly activeTools = new Map<string, number>();
  private readonly tools = new Map<string, { calls: number; durationMs: number }>();
  private cardsReadyMs?: number;
  private briefingReadyMs?: number;

  usage(value: ModelUsageUpdate) {
    const previous = this.attempts.get(value.id);
    if (previous && previous.usage.status !== "pending") return;
    const now = performance.now();
    this.attempts.set(value.id, {
      started: previous?.started ?? now,
      ...(value.status !== "pending" ? { elapsed: now - (previous?.started ?? now) } : {}),
      usage: value,
    });
  }

  activity(name: string, active: boolean) {
    if (active) {
      if (!this.activeTools.has(name)) this.activeTools.set(name, performance.now());
    }
    else {
      const started = this.activeTools.get(name);
      if (started === undefined) return;
      this.activeTools.delete(name);
      const previous = this.tools.get(name) ?? { calls: 0, durationMs: 0 };
      this.tools.set(name, { calls: previous.calls + 1, durationMs: previous.durationMs + performance.now() - started });
    }
  }

  ready(cards: boolean, voice: boolean) {
    const elapsed = Math.round(performance.now() - this.started);
    if (cards) this.cardsReadyMs ??= elapsed;
    if (voice) this.briefingReadyMs ??= elapsed;
  }

  snapshot() {
    const now = performance.now();
    const attempts = [...this.attempts.values()];
    const tools = new Map(this.tools);
    for (const [name, started] of this.activeTools) {
      const previous = tools.get(name) ?? { calls: 0, durationMs: 0 };
      tools.set(name, { calls: previous.calls + 1, durationMs: previous.durationMs + now - started });
    }
    const sum = (field: "inputTokens" | "cachedInputTokens" | "cacheWriteInputTokens" | "outputTokens" | "reasoningTokens") => {
      const values = attempts.map(({ usage }) => usage[field]);
      return values.every((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
    };
    return {
      durationMs: Math.round(now - this.started),
      completions: attempts.length,
      modelMs: Math.round(attempts.reduce((total, attempt) => total + (attempt.elapsed ?? now - attempt.started), 0)),
      inputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"),
      cacheWriteInputTokens: sum("cacheWriteInputTokens"), outputTokens: sum("outputTokens"), reasoningTokens: sum("reasoningTokens"),
      tools: Object.fromEntries([...tools].map(([name, value]) => [name, { ...value, durationMs: Math.round(value.durationMs) }])),
      cardsReadyMs: this.cardsReadyMs ?? null,
      briefingReadyMs: this.briefingReadyMs ?? null,
    };
  }
}
