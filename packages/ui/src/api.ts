/**
 * Token-aware fetch helpers for the Mission Control UI.
 *
 * Auth is OFF by default (loopback single-user): no token, requests go through
 * unchanged. When auth is ON, the bearer token from POST /api/login is held in
 * module memory and attached as an Authorization header on every API call (and
 * as a ?ticket= query param on the WebSocket upgrade, which can't set headers).
 *
 * The token lives only in memory — refreshing the page requires logging in
 * again, matching the spec's "store token in memory" guidance. Dependency-free.
 */

let authToken: string | undefined;

export function setAuthToken(token: string | undefined): void {
  authToken = token;
}

export function getAuthToken(): string | undefined {
  return authToken;
}

function withAuthHeaders(init?: RequestInit): RequestInit {
  if (authToken === undefined) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${authToken}`);
  return { ...init, headers };
}

/** GET + parse JSON, attaching the bearer token when present. */
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, withAuthHeaders());
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** fetch() that attaches the bearer token (for POST/PUT/DELETE mutations). */
export function authFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, withAuthHeaders(init));
}

/**
 * Build the WS upgrade URL with a short-lived single-use ticket (FIX 3).
 *
 * When auth is OFF (no token) the base URL is returned unchanged. When auth is
 * ON, we first POST /api/ws-ticket (authenticated with the bearer token in the
 * Authorization header) to mint a 30s single-use ticket, then attach THAT as the
 * ?ticket= param — never the long-lived bearer token (which would land in
 * request logs). Throws if the ticket cannot be minted so the caller can surface
 * the failure rather than open an unauthenticated socket.
 */
export async function wsUrlWithTicket(base: string): Promise<string> {
  if (authToken === undefined) return base;
  const res = await authFetch('/api/ws-ticket', { method: 'POST' });
  if (!res.ok) throw new Error(`ws-ticket → ${res.status}`);
  const { ticket } = (await res.json()) as { ticket: string };
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ticket=${encodeURIComponent(ticket)}`;
}

/** POST /api/login → { token, principal }. Throws on failure. */
export interface LoginResponse {
  token: string;
  principal: { id: string; displayName: string; kind: string };
  expiresAt?: string;
}

export async function login(user: string, password: string): Promise<LoginResponse> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  if (!res.ok) throw new Error(`login → ${res.status}`);
  return (await res.json()) as LoginResponse;
}

export interface WhoamiResponse {
  authMode: 'off' | 'on';
  principal: { id: string; displayName: string; kind: string };
  role: string | null;
  implicit: boolean;
}

/** GET /api/whoami → current principal + auth mode (token-aware). */
export async function whoami(): Promise<WhoamiResponse> {
  return getJson<WhoamiResponse>('/api/whoami');
}
