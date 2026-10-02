import type { QuestionSelection } from "../../shared/questions";

/** Server-projected history shared by text and voice; never a browser input. */
export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
  /** Roman has replied through a widget, even when no assistant prose exists. */
  source?: "roman_question" | "application_state" | "memory";
  /** Original source range, unaffected by display reordering/grouping. */
  sequence?: number;
  endSequence?: number;
  /** Typed metadata for channel lifecycle decisions; text owns the model projection. */
  pendingQuestion?: QuestionSelection;
}
