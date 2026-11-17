import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { member } from '../../src/db/schema/index.js';
import type { TestApp } from './app.js';

/** A signed-in user whose active workspace is `workspaceId`. */
export interface TestUser {
  /** `Cookie` header value carrying the Better Auth session. */
  cookie: string;
  userId: string;
  workspaceId: string;
  email: string;
}

export interface ApiResponse {
  status: number;
  /** Parsed JSON body; `undefined` when the response has none (202, 204). */
  body: unknown;
}

export interface ApiClient {
  get(path: string): Promise<ApiResponse>;
  post(path: string, body?: unknown): Promise<ApiResponse>;
  patch(path: string, body: unknown): Promise<ApiResponse>;
  del(path: string): Promise<ApiResponse>;
}

const PASSWORD = 'correct horse battery staple';
const SignUpResponse = z.object({ user: z.object({ id: z.string().min(1) }) });
const OrganizationResponse = z.object({ id: z.string().min(1) });

type CookieJar = Map<string, string>;

function storeCookies(jar: CookieJar, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator > 0) jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** POSTs to a Better Auth endpoint like a browser on the trusted origin would. */
async function authPost(t: TestApp, jar: CookieJar, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${t.baseUrl}/api/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: t.baseUrl,
      ...(jar.size > 0 ? { cookie: cookieHeader(jar) } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST /api/auth${path} failed with ${response.status}: ${text}`);
  }
  storeCookies(jar, response);
  return text.length > 0 ? JSON.parse(text) : null;
}

async function signUp(
  t: TestApp,
  name: string,
): Promise<{ jar: CookieJar; userId: string; email: string }> {
  const jar: CookieJar = new Map();
  const email = `user-${randomUUID()}@coffe.test`;
  const result = SignUpResponse.parse(
    await authPost(t, jar, '/sign-up/email', { name, email, password: PASSWORD }),
  );
  if (jar.size === 0) throw new Error('sign-up did not set a session cookie');
  return { jar, userId: result.user.id, email };
}

/** Signs up a new user who owns a new workspace (their active one). */
export async function signUpWithWorkspace(t: TestApp, name = 'Olivia Owner'): Promise<TestUser> {
  const { jar, userId, email } = await signUp(t, name);
  const organization = OrganizationResponse.parse(
    await authPost(t, jar, '/organization/create', {
      name: `${name}'s workspace`,
      slug: `ws-${randomUUID()}`,
    }),
  );
  await authPost(t, jar, '/organization/set-active', { organizationId: organization.id });
  return { cookie: cookieHeader(jar), userId, workspaceId: organization.id, email };
}

/** Signs up another user and makes them a `role` member of the owner's workspace. */
export async function addMember(
  t: TestApp,
  owner: TestUser,
  role: 'member' | 'reviewer',
): Promise<TestUser> {
  const { jar, userId, email } = await signUp(t, role === 'member' ? 'Marc Member' : 'Rita Reviewer');
  await t.db.insert(member).values({
    id: randomUUID(),
    organizationId: owner.workspaceId,
    userId,
    role,
    createdAt: new Date(),
  });
  await authPost(t, jar, '/organization/set-active', { organizationId: owner.workspaceId });
  return { cookie: cookieHeader(jar), userId, workspaceId: owner.workspaceId, email };
}

/** REST client for paths relative to `/api/v1`; `user: null` sends no session. */
export function api(t: TestApp, user: TestUser | null): ApiClient {
  async function call(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const response = await fetch(`${t.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        origin: t.baseUrl,
        ...(user ? { cookie: user.cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
  }
  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
  };
}
