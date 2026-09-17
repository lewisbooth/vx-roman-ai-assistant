/** Server-projected history shared by text and voice; never a browser input. */
export interface ModelMessage {
  role: "user" | "assistant";
  text: string;
  /** Roman has replied through a widget, even when no assistant prose exists. */
  source?: "roman_question";
}
