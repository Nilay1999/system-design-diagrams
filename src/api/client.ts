/**
 * Thin fetch wrapper for the community API. The API is served same-origin under /api
 * (a Vercel rewrite in production), so the session cookie is first-party and no CORS is needed.
 */

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  /** Serialised as the JSON request body. */
  json?: unknown;
  /** Sent as `Idempotency-Key`, so a retried create is applied once. */
  idempotencyKey?: string;
}

export async function request<T>(path: string, { json, idempotencyKey, headers, ...init }: RequestOptions = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(json !== undefined && { "Content-Type": "application/json" }),
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      ...headers,
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

  const body: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    const message = (body as { message?: string } | undefined)?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, init?: RequestOptions) => request<T>(path, { ...init, method: "GET" }),
  post: <T>(path: string, json?: unknown, init?: RequestOptions) => request<T>(path, { ...init, method: "POST", json }),
  put: <T>(path: string, json?: unknown, init?: RequestOptions) => request<T>(path, { ...init, method: "PUT", json }),
  patch: <T>(path: string, json?: unknown, init?: RequestOptions) => request<T>(path, { ...init, method: "PATCH", json }),
  delete: <T>(path: string, init?: RequestOptions) => request<T>(path, { ...init, method: "DELETE" }),
};
