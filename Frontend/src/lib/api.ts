/**
 * The single place this app talks to the API.
 *
 * Two things it handles so no screen has to:
 *
 *   Access tokens are short-lived (15 minutes). On a 401 this refreshes once
 *   and replays the original request. Concurrent requests share one refresh
 *   rather than each firing their own — the backend rotates refresh tokens
 *   and revokes the whole family on reuse, so a burst of parallel refreshes
 *   would log the user out.
 *
 *   The API returns a consistent error envelope with a stable `code`. That
 *   is turned into an ApiError carrying the code, so screens branch on
 *   `INSUFFICIENT_DATA` rather than matching on message text.
 */

const RAW_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const API_BASE = RAW_BASE.replace(/\/+$/, '');
const API = `${API_BASE}/api/v1`;

const ACCESS_KEY = 'bakecheck.access';
const REFRESH_KEY = 'bakecheck.refresh';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Array<{ field: string; constraints: string[] }>;
  correlationId?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: ApiErrorBody['details'];
  readonly correlationId?: string;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
    this.correlationId = body.correlationId;
  }

  /** Field errors from validation, keyed by field name. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of this.details ?? []) {
      out[d.field] = d.constraints[0] ?? 'This value is not valid.';
    }
    return out;
  }
}

// ── Token storage ──────────────────────────────────────────────────────────
//
// sessionStorage, not localStorage: a shared laboratory workstation should
// not keep someone signed in once the browser is closed. Every access is
// wrapped because storage throws in private-mode and blocked-cookie contexts.

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable; the session simply does not survive a reload */
  }
}

export const tokens = {
  access: () => read(ACCESS_KEY),
  refresh: () => read(REFRESH_KEY),
  set(access: string, refresh: string) {
    write(ACCESS_KEY, access);
    write(REFRESH_KEY, refresh);
  },
  clear() {
    write(ACCESS_KEY, null);
    write(REFRESH_KEY, null);
  },
};

/** Notified when the session ends, so the app can route to sign-in. */
type Listener = () => void;
const sessionEndedListeners = new Set<Listener>();
export function onSessionEnded(fn: Listener): () => void {
  sessionEndedListeners.add(fn);
  return () => sessionEndedListeners.delete(fn);
}
function endSession(): void {
  tokens.clear();
  sessionEndedListeners.forEach((fn) => fn());
}

// ── Refresh ────────────────────────────────────────────────────────────────

let inFlightRefresh: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  // Share one refresh across every caller waiting on it.
  if (inFlightRefresh) return inFlightRefresh;

  const refreshToken = tokens.refresh();
  if (!refreshToken) return false;

  inFlightRefresh = (async () => {
    try {
      const response = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
      };
      tokens.set(body.accessToken, body.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

// ── Request ────────────────────────────────────────────────────────────────

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Set for multipart uploads; the browser must pick the boundary itself. */
  formData?: FormData;
  signal?: AbortSignal;
  /** Skips the Authorization header — used by sign-in and registration. */
  anonymous?: boolean;
}

async function send<T>(path: string, options: RequestOptions, retry: boolean): Promise<T> {
  const headers: Record<string, string> = {};
  if (!options.formData) headers['content-type'] = 'application/json';

  const access = tokens.access();
  if (access && !options.anonymous) headers.authorization = `Bearer ${access}`;

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.formData ?? (options.body ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // A failed fetch is almost always the API being unreachable, which is
    // worth saying plainly rather than surfacing "Failed to fetch".
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message:
        'Could not reach the BakeCheck API. Check that it is running and that ' +
        'VITE_API_URL points at it.',
    });
  }

  if (response.status === 401 && retry && !options.anonymous) {
    if (await refreshSession()) return send<T>(path, options, false);
    endSession();
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const envelope = (parsed as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(
      response.status,
      envelope ?? { code: 'UNKNOWN', message: `Request failed (${response.status}).` },
    );
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => send<T>(path, { signal }, true),
  post: <T>(path: string, body?: unknown, opts: Partial<RequestOptions> = {}) =>
    send<T>(path, { method: 'POST', body, ...opts }, true),
  patch: <T>(path: string, body?: unknown) => send<T>(path, { method: 'PATCH', body }, true),
  upload: <T>(path: string, formData: FormData) =>
    send<T>(path, { method: 'POST', formData }, true),
};

/**
 * Fetches a protected image and returns an object URL.
 *
 * Image endpoints need the Authorization header, so `<img src>` cannot load
 * them directly. Callers must revoke the URL when the element unmounts.
 */
export async function fetchImageObjectUrl(imageId: string): Promise<string> {
  const access = tokens.access();
  const response = await fetch(`${API}/images/${imageId}`, {
    headers: access ? { authorization: `Bearer ${access}` } : {},
  });
  if (!response.ok) throw new Error('Could not load the image.');
  return URL.createObjectURL(await response.blob());
}
