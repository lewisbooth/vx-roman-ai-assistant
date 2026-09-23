export class ConversationError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConversationError";
  }
}

export class ServiceUnavailableError extends ConversationError {
  constructor() {
    super(503, "Roman is currently unavailable");
    this.name = "ServiceUnavailableError";
  }
}
