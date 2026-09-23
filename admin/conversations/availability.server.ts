import OpenAI from "openai";
import {
  getApiAvailability,
  setApiAvailability,
} from "../api-errors/repository.server";
import { ServiceUnavailableError } from "./errors.server";

export const PRIMARY_TEXT_MODEL = "gpt-6-luna";
export const FALLBACK_TEXT_MODEL = "gpt-5.6-luna";
export const UNAVAILABLE_MESSAGE = "Roman is currently unavailable";

export type AvailabilityStatus = "available" | "degraded" | "suspended";

let status: AvailabilityStatus = "available";
let initialization: Promise<void> | undefined;
let persistence: Promise<void> = Promise.resolve();
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let probing = false;
let probeDelayMs = 1_000;
let probeClient: OpenAI | undefined;
const suspensionListeners = new Set<() => void>();

function scheduleProbe() {
  if (status === "available" || probeTimer || probing) return;
  probeTimer = setTimeout(() => {
    probeTimer = undefined;
    void probeModels();
  }, probeDelayMs);
  probeTimer.unref?.();
}

async function checkModel(model: string): Promise<boolean> {
  try {
    probeClient ??= new OpenAI({ maxRetries: 0, timeout: 10_000 });
    const response = await probeClient.responses.create({
      model,
      service_tier: "fast",
      reasoning: { effort: "medium" },
      input: "Reply with OK.",
      max_output_tokens: 256,
      store: false,
    });
    return response.status === "completed";
  } catch {
    // Probe failures are represented by the open incident, not a log entry
    // containing a provider error body every few seconds.
    return false;
  }
}

async function probeModels() {
  if (probing || status === "available") return;
  probing = true;
  try {
    if (await checkModel(PRIMARY_TEXT_MODEL)) {
      probeDelayMs = 1_000;
      await transition("available");
    } else if (status === "suspended" && (await checkModel(FALLBACK_TEXT_MODEL))) {
      probeDelayMs = 1_000;
      await transition("degraded");
    } else {
      probeDelayMs = Math.min(probeDelayMs * 2, 30_000);
    }
  } finally {
    probing = false;
    scheduleProbe();
  }
}

function transition(next: AvailabilityStatus): Promise<void> {
  if (status === next) return persistence;
  status = next;
  if (next === "available" && probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = undefined;
  }
  if (next === "suspended")
    for (const listener of suspensionListeners) listener();
  console.warn("[Roman] API availability changed.", { status: next });
  persistence = persistence.then(async () => {
    try {
      await setApiAvailability(
        next === "available"
          ? "healthy"
          : next === "degraded"
            ? "fallback"
            : "outage",
      );
    } catch {
      console.error("[Roman] API availability incident could not be saved.");
    }
  });
  scheduleProbe();
  return persistence;
}

async function initialize() {
  initialization ??= (async () => {
    try {
      const saved = await getApiAvailability();
      status =
        saved === "healthy"
          ? "available"
          : saved === "fallback"
            ? "degraded"
            : "suspended";
      if (status === "suspended")
        for (const listener of suspensionListeners) listener();
      scheduleProbe();
    } catch {
      // A persisted outage must not silently become healthy on restart merely
      // because the incident store could not be read.
      status = "suspended";
      console.error("[Roman] API availability incident could not be read.");
      scheduleProbe();
    }
  })();
  await initialization;
}

/** Start persisted-incident probes as soon as the server bundle loads. */
export function startAvailabilityProbes(): void {
  void initialize();
}

export async function getAvailabilityStatus(): Promise<AvailabilityStatus> {
  await initialize();
  return status;
}

export async function textModelForRequest(): Promise<string> {
  await initialize();
  if (status === "suspended")
    throw new ServiceUnavailableError();
  return status === "degraded" ? FALLBACK_TEXT_MODEL : PRIMARY_TEXT_MODEL;
}

export async function assertServiceAvailable(): Promise<void> {
  await textModelForRequest();
}

export function isServiceSuspended(): boolean {
  return status === "suspended";
}

export async function reportPrimaryUnavailable(): Promise<void> {
  await initialize();
  if (status === "available") await transition("degraded");
  else scheduleProbe();
}

export async function reportFallbackUnavailable(): Promise<void> {
  await initialize();
  // A concurrent successful primary probe already restored the service.
  if (status !== "available") await transition("suspended");
}

export function onServiceSuspended(listener: () => void): () => void {
  suspensionListeners.add(listener);
  return () => suspensionListeners.delete(listener);
}
