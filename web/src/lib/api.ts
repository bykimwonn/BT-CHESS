export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
    /** Per-field messages from the server, keyed by request field name. */
    public readonly fields?: Record<string, string>,
  ) { super(message); this.name = 'ApiError'; }
}

export function cookie(name: string): string {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return '';
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  raw?: boolean;
  signal?: AbortSignal | null;
}

export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, raw, headers, signal, ...rest } = options;
  const method = (rest.method ?? 'GET').toUpperCase();
  const requestHeaders = new Headers(headers);
  if (body !== undefined && !(body instanceof FormData)) requestHeaders.set('Content-Type', 'application/json');
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = cookie('rs_csrf');
    if (csrf) requestHeaders.set('X-CSRF-Token', csrf);
  }
  const response = await fetch(`/api${path}`, {
    ...rest,
    method,
    credentials: 'same-origin',
    headers: requestHeaders,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    signal: signal ?? undefined,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = raw ? await response.text()
    : contentType.includes('application/json') ? await response.json()
      : await response.text();
  if (!response.ok) {
    const error = typeof payload === 'object' && payload && 'error' in payload
      ? (payload as { error: { code?: string; message?: string; detail?: unknown; fields?: Record<string, string> } }).error
      : { code: 'http_error', message: `Request failed with status ${response.status}` };
    throw new ApiError(response.status, error.code ?? 'http_error', error.message ?? 'Request failed', error.detail, error.fields);
  }
  return payload as T;
}

export function apiUrl(path: string): string { return `/api${path}`; }

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
