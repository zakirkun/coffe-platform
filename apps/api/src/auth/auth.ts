import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { ac, roles } from './access.js';

type DrizzleDb = Parameters<typeof drizzleAdapter>[0];
type DrizzleSchema = NonNullable<Parameters<typeof drizzleAdapter>[1]['schema']>;

export interface InvitationNotice {
  id: string;
  email: string;
  role: string;
  organizationName: string;
  inviterEmail: string;
  url: string;
}

export interface CreateAuthOptions {
  db: DrizzleDb;
  /** Drizzle tables keyed by Better Auth model name (`user`, `session`, `organization`, …). */
  schema: DrizzleSchema;
  /** Public origin, e.g. `https://coffe.example.com`. */
  baseURL: string;
  secret: string;
  trustedOrigins: string[];
  /** Called for every invitation; email delivery is optional (links can be copied in the UI). */
  onInvitation?: (notice: InvitationNotice) => Promise<void> | void;
}

export interface AuthSession {
  user: { id: string; name: string; email: string; image: string | null };
  session: { id: string; activeOrganizationId: string | null; expiresAt: Date };
}

/** The slice of Better Auth the control plane uses. */
export interface CoffeAuth {
  /** Fetch-style handler serving `/api/auth/*`. */
  handler(request: Request): Promise<Response>;
  /** Resolves the session from request headers (session cookie); `null` when signed out. */
  getSession(headers: Headers): Promise<AuthSession | null>;
}

/**
 * Raw Better Auth instance: email + password, organizations (= workspaces) with COFFE roles.
 * Also loaded by the Better Auth CLI (`better-auth.config.ts`) to generate the auth schema.
 */
export function buildBetterAuth(options: CreateAuthOptions) {
  return betterAuth({
    appName: 'COFFE',
    baseURL: options.baseURL,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(options.db, { provider: 'pg', schema: options.schema }),
    emailAndPassword: { enabled: true, autoSignIn: true, minPasswordLength: 8 },
    advanced: { cookiePrefix: 'coffe' },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: 'owner',
        allowUserToCreateOrganization: true,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        sendInvitationEmail: async (data) => {
          await options.onInvitation?.({
            id: data.id,
            email: data.email,
            role: data.role,
            organizationName: data.organization.name,
            inviterEmail: data.inviter.user.email,
            url: `${options.baseURL}/invite/${data.id}`,
          });
        },
      }),
    ],
  });
}

export function createAuth(options: CreateAuthOptions): CoffeAuth {
  const auth = buildBetterAuth(options);
  return {
    handler: (request) => auth.handler(request),
    async getSession(headers) {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      return {
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          image: result.user.image ?? null,
        },
        session: {
          id: result.session.id,
          activeOrganizationId: result.session.activeOrganizationId ?? null,
          expiresAt: result.session.expiresAt,
        },
      };
    },
  };
}
