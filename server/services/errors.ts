export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) { super(message); this.name = 'AppError'; }
}

export const badRequest = (message: string, detail?: unknown) => new AppError(400, 'bad_request', message, detail);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string, detail?: unknown) => new AppError(409, 'conflict', message, detail);
export const unavailable = (message: string, detail?: unknown) => new AppError(503, 'unavailable', message, detail);
