// Type-only import that brings in the `request.cookies` / `reply.setCookie` declarations.
import type {} from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addTeamMemberRequestSchema,
  changePasswordRequestSchema,
  createTeamRequestSchema,
  createUserRequestSchema,
  idSchema,
  jwksResponseSchema,
  listUsersQuerySchema,
  loginRequestSchema,
  sessionResponseSchema,
  teamListResponseSchema,
  teamMemberListResponseSchema,
  updateUserRequestSchema,
  teamResponseSchema,
  userListResponseSchema,
  userResponseSchema,
  type JwksResponse,
  type SessionResponse,
  type TeamResponse,
  type UserResponse,
} from '@teampulse/contracts';
import { defineRoute, type Route } from '@teampulse/http';
import { err, forbiddenError, ok, type Result } from '@teampulse/kernel';
import {
  invalidRefreshToken,
  type IdentityUseCases,
  type Session,
} from '../../application/index.js';
import type { TeamSummary } from '../../domain/team.js';
import type { User } from '../../domain/user.js';

export interface CookieOptions {
  readonly name: string;
  /** Limits where the browser sends the cookie: only the auth endpoints ever see it. */
  readonly path: string;
  /** Always true outside local development. */
  readonly secure: boolean;
}

export interface IdentityRouteOptions {
  readonly useCases: IdentityUseCases;
  readonly jwks: () => JwksResponse;
  readonly cookie: CookieOptions;
}

/* ------------------------------------------------------------------------------------------
 * Mappers: domain objects in, explicit DTOs out. A field only leaves the service if it is
 * written here AND declared in the contract schema (which is strict), so the password hash can
 * never reach a client by accident.
 * ---------------------------------------------------------------------------------------- */

export const toUserResponse = (user: User): UserResponse => ({
  id: user.id,
  email: user.email.value,
  displayName: user.displayName,
  role: user.role,
  status: user.status,
});

export const toTeamResponse = ({ team, memberCount }: TeamSummary): TeamResponse => ({
  id: team.id,
  name: team.name,
  managerUserId: team.managerUserId,
  memberCount,
});

const toSessionResponse = (session: Session): SessionResponse => ({
  accessToken: session.accessToken,
  tokenType: 'Bearer',
  expiresIn: session.expiresInSeconds,
  user: toUserResponse(session.user),
});

/* ------------------------------------------------------------------------------------------ */

/**
 * Cookie endpoints (refresh, logout) must be called by our own web app. Browsers do not let
 * another site add a custom header without a CORS preflight, which our CORS policy refuses.
 * Together with SameSite=Strict and JSON-only bodies this closes the CSRF routes.
 */
export const CLIENT_HEADER = 'x-requested-with';
export const CLIENT_HEADER_VALUE = 'teampulse-web';

function requireWebClient(request: FastifyRequest): Result<void> {
  return request.headers[CLIENT_HEADER] === CLIENT_HEADER_VALUE
    ? ok(undefined)
    : err(
        forbiddenError(
          'auth.client_header_required',
          'This request must come from the TeamPulse app',
        ),
      );
}

export function buildIdentityRoutes(options: IdentityRouteOptions): Route[] {
  const { useCases, cookie } = options;

  const setRefreshCookie = (reply: FastifyReply, session: Session): void => {
    void reply.setCookie(cookie.name, session.refresh.secret, {
      path: cookie.path,
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'strict',
      expires: session.refresh.expiresAt,
    });
  };

  const clearRefreshCookie = (reply: FastifyReply): void => {
    void reply.clearCookie(cookie.name, {
      path: cookie.path,
      httpOnly: true,
      secure: cookie.secure,
      sameSite: 'strict',
    });
  };

  const readRefreshCookie = (request: FastifyRequest): string | undefined =>
    request.cookies[cookie.name] || undefined;

  const userIdParam = z.strictObject({ userId: idSchema });
  const teamIdParam = z.strictObject({ teamId: idSchema });

  return [
    /* --------------------------------- session ---------------------------------- */
    defineRoute({
      method: 'POST',
      path: '/auth/login',
      summary: 'Sign in with email and password',
      tags: ['auth'],
      auth: 'public',
      rateLimit: { max: 10, timeWindowMs: 60_000 },
      body: loginRequestSchema,
      success: { status: 200, schema: sessionResponseSchema },
      handler: async ({ body, reply }) => {
        const result = await useCases.login.execute(body);
        if (!result.ok) return result;
        setRefreshCookie(reply, result.value);
        return ok(toSessionResponse(result.value));
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/auth/refresh',
      summary: 'Exchange the refresh cookie for a new access token (rotates the cookie)',
      tags: ['auth'],
      auth: 'public',
      rateLimit: { max: 30, timeWindowMs: 60_000 },
      success: { status: 200, schema: sessionResponseSchema },
      handler: async ({ request, reply }) => {
        const client = requireWebClient(request);
        if (!client.ok) return client;

        const refreshToken = readRefreshCookie(request);
        if (refreshToken === undefined) return err(invalidRefreshToken());

        const result = await useCases.refresh.execute({ refreshToken });
        if (result.ok) {
          setRefreshCookie(reply, result.value);
          return ok(toSessionResponse(result.value));
        }
        // A dead session: drop the cookie so the browser stops presenting it. A benign race
        // keeps it, because the winning request has just set a fresh one.
        if (result.error.code !== 'auth.refresh_race') clearRefreshCookie(reply);
        return result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/auth/logout',
      summary: 'End the current session',
      tags: ['auth'],
      auth: 'public',
      success: { status: 204 },
      handler: async ({ request, reply }) => {
        const client = requireWebClient(request);
        if (!client.ok) return client;
        await useCases.logout.execute({ refreshToken: readRefreshCookie(request) });
        clearRefreshCookie(reply);
        return ok(undefined);
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/.well-known/jwks.json',
      summary: 'Public keys for verifying access tokens',
      tags: ['auth'],
      auth: 'public',
      success: { status: 200, schema: jwksResponseSchema },
      handler: ({ reply }) => {
        // Public and slow-changing: let intermediaries cache it. Services also cache by `kid`.
        void reply.header('cache-control', 'public, max-age=300');
        return Promise.resolve(ok(options.jwks()));
      },
    }),

    /* ----------------------------------- me ------------------------------------- */
    defineRoute({
      method: 'GET',
      path: '/me',
      summary: 'The signed-in user',
      tags: ['me'],
      auth: 'required',
      success: { status: 200, schema: userResponseSchema },
      handler: async ({ principal }) => {
        const result = await useCases.getCurrentUser.execute({ actor: principal });
        return result.ok ? ok(toUserResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/me/password',
      summary: 'Change your password (signs you out everywhere)',
      tags: ['me'],
      auth: 'required',
      rateLimit: { max: 10, timeWindowMs: 60_000 },
      body: changePasswordRequestSchema,
      success: { status: 204 },
      handler: async ({ principal, body, reply }) => {
        const result = await useCases.changePassword.execute({ actor: principal, ...body });
        if (result.ok) clearRefreshCookie(reply);
        return result;
      },
    }),

    /* ---------------------------------- users ----------------------------------- */
    defineRoute({
      method: 'POST',
      path: '/users',
      summary: 'Create a user (admin)',
      tags: ['users'],
      auth: 'required',
      body: createUserRequestSchema,
      success: { status: 201, schema: userResponseSchema },
      handler: async ({ principal, body }) => {
        const result = await useCases.createUser.execute({ actor: principal, ...body });
        return result.ok ? ok(toUserResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/users',
      summary: 'List users (admin)',
      tags: ['users'],
      auth: 'required',
      query: listUsersQuerySchema,
      success: { status: 200, schema: userListResponseSchema },
      handler: async ({ principal, query }) => {
        const result = await useCases.listUsers.execute({ actor: principal, ...query });
        if (!result.ok) return result;
        return ok({
          items: result.value.items.map(toUserResponse),
          ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }),
        });
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/users/:userId',
      summary: 'Change a user role and/or status, for example to disable an account (admin)',
      tags: ['users'],
      auth: 'required',
      params: userIdParam,
      body: updateUserRequestSchema,
      success: { status: 200, schema: userResponseSchema },
      handler: async ({ principal, params, body }) => {
        const result = await useCases.updateUser.execute({
          actor: principal,
          userId: params.userId,
          ...body,
        });
        return result.ok ? ok(toUserResponse(result.value)) : result;
      },
    }),

    defineRoute({
      method: 'DELETE',
      path: '/users/:userId',
      summary: 'Delete a user and all their data (admin)',
      tags: ['users'],
      auth: 'required',
      params: userIdParam,
      success: { status: 204 },
      handler: ({ principal, params }) =>
        useCases.deleteUser.execute({ actor: principal, userId: params.userId }),
    }),

    /* ---------------------------------- teams ----------------------------------- */
    defineRoute({
      method: 'POST',
      path: '/teams',
      summary: 'Create a team (admin)',
      tags: ['teams'],
      auth: 'required',
      body: createTeamRequestSchema,
      success: { status: 201, schema: teamResponseSchema },
      handler: async ({ principal, body }) => {
        const result = await useCases.createTeam.execute({ actor: principal, ...body });
        return result.ok ? ok(toTeamResponse({ team: result.value, memberCount: 0 })) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/teams',
      summary: 'Teams visible to you (all teams for admins)',
      tags: ['teams'],
      auth: 'required',
      success: { status: 200, schema: teamListResponseSchema },
      handler: async ({ principal }) => {
        const result = await useCases.listTeams.execute({ actor: principal });
        return result.ok ? ok({ items: result.value.map(toTeamResponse) }) : result;
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/teams/:teamId/members',
      summary: 'Team roster: names only (admin, the manager, or a member)',
      tags: ['teams'],
      auth: 'required',
      params: teamIdParam,
      success: { status: 200, schema: teamMemberListResponseSchema },
      handler: async ({ principal, params }) => {
        const result = await useCases.listTeamMembers.execute({
          actor: principal,
          teamId: params.teamId,
        });
        return result.ok
          ? ok({ items: result.value.map((m) => ({ id: m.id, displayName: m.displayName })) })
          : result;
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/teams/:teamId/members',
      summary: 'Add a member to a team (admin)',
      tags: ['teams'],
      auth: 'required',
      params: teamIdParam,
      body: addTeamMemberRequestSchema,
      success: { status: 204 },
      handler: ({ principal, params, body }) =>
        useCases.addTeamMember.execute({
          actor: principal,
          teamId: params.teamId,
          userId: body.userId,
        }),
    }),

    defineRoute({
      method: 'DELETE',
      path: '/teams/:teamId/members/:userId',
      summary: 'Remove a member from a team (admin)',
      tags: ['teams'],
      auth: 'required',
      params: z.strictObject({ teamId: idSchema, userId: idSchema }),
      success: { status: 204 },
      handler: ({ principal, params }) =>
        useCases.removeTeamMember.execute({
          actor: principal,
          teamId: params.teamId,
          userId: params.userId,
        }),
    }),
  ];
}
