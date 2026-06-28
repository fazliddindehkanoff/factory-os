/** Typed domain errors. The HTTP layer maps these to status codes; services stay framework-free. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation', message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('forbidden', message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('not_found', message);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super('conflict', message);
  }
}
