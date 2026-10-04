/** The input is not a processable video (no video stream / unreadable container). */
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}
