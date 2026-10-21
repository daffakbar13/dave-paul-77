import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import type { z } from 'zod';

// Thrown from handlers; the error handler turns it into `{ error, ...details }`.
export class HttpError extends Error {
  status: number;
  details: Record<string, unknown> | undefined;

  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = () => new HttpError(403, 'You do not have access to this resource.');

// A malformed id can never match a document, so it is a plain not-found.
export function parseId(value: unknown, what: string): ObjectId {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) throw notFound(`${what} not found`);
  return new ObjectId(value);
}

// Every request body and query goes through a schema; the first issue becomes the 400 message.
export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, `${where}${issue?.message ?? 'Invalid input.'}`);
}

export const unknownRoute: RequestHandler = (_req, _res, next) => next(notFound());

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...err.details });
    return;
  }
  // express.json() parse errors carry a 4xx status
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: 'Invalid request body.' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
};
