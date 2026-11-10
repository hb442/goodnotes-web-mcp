export class GoodnotesError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function checkCancellation(signal) {
  if (signal?.aborted)
    throw new GoodnotesError(
      'CANCELLED',
      'The request was cancelled or timed out. Check its operation receipt before retrying.',
    );
}
