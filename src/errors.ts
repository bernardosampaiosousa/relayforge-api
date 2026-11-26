export class HttpError extends Error {
  // Carries an intentional status code from repository code to the HTTP handler.
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
