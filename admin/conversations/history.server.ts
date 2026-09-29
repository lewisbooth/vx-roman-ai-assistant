import type { QuestionSelection } from "../../shared/questions";

/** Server-projected history shared by text and voice; never a browser input. */
export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
  /** Roman has replied through a widget, even when no assistant prose exists. */
  source?: "roman_question" | "application_state";
  /** Typed metadata for channel lifecycle decisions; text owns the model projection. */
  pendingQuestion?: QuestionSelection;
}
