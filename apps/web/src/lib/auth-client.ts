import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth browser client (email + password, organizations = workspaces). Same-origin:
 * the base URL defaults to the page origin, so the session cookie applies to `/api/*`.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient()],
});
