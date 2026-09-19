export class IntegrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IntegrationError";
  }
}
