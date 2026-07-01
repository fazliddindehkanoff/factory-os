/** Maps domain errors to HTTP responses. Unknown errors become a generic 500. */
import { AppError } from '../services/errors.js';

const STATUS_BY_CODE: Record<string, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

export function mapError(err: unknown): { status: number; body: { error: string; code?: string } } {
  if (err instanceof AppError) {
    return { status: STATUS_BY_CODE[err.code] ?? 500, body: { error: err.message, code: err.code } };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}
