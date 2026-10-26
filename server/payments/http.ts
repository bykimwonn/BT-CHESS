import { ProviderError } from './types.js';

export type FetchLike = typeof fetch;

export async function requestJson<T = Record<string, unknown>>(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, ...rest } = init;
  const response = await fetchFn(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new ProviderError(`Provider returned HTTP ${response.status}`, 'provider_http_error', response.status);
  return body as T;
}

export async function requestText(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<string> {
  const { timeoutMs = 15_000, ...rest } = init;
  const response = await fetchFn(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new ProviderError(`Provider returned HTTP ${response.status}`, 'provider_http_error', response.status);
  return text;
}

export function firstHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] : value;
}
