import { CONVERSATION_STORAGE_KEY } from "../../shared/conversation";

export const WELCOME_STORAGE_KEY = "roman:welcome-state";

/** Appearance only, never session authority. Read before painting the loader. */
export function readWelcomeState(): boolean | undefined {
  let welcome: boolean | undefined = true;
  try {
    const access = JSON.parse(sessionStorage.getItem(CONVERSATION_STORAGE_KEY) ?? "null");
    if (!access?.conversationId) return true;
    welcome = undefined;
    const saved = JSON.parse(sessionStorage.getItem(WELCOME_STORAGE_KEY) ?? "null");
    return saved?.conversationId === access.conversationId &&
      typeof saved.welcome === "boolean" ? saved.welcome : undefined;
  } catch {
    return welcome;
  }
}

export function persistWelcomeState(welcome: boolean, conversationId?: string) {
  try {
    if (conversationId)
      sessionStorage.setItem(WELCOME_STORAGE_KEY, JSON.stringify({ conversationId, welcome }));
    else sessionStorage.removeItem(WELCOME_STORAGE_KEY);
  } catch {
    // Optional presentation cache. The session owner reports storage failures.
  }
}
