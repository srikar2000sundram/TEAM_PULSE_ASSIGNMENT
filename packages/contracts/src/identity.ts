import { z } from 'zod';
import { idSchema, roleSchema } from './common.js';

/**
 * Identity API contracts, shared by the Identity Service (server) and the web app (client).
 * Request bodies are strict: unknown fields are rejected rather than silently ignored.
 */

export const MAX_TEAM_CLAIMS = 20;

/** Claims inside every access token. Other services authorize from these without calling Identity. */
export const accessTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.union([z.string().min(1), z.array(z.string().min(1))]),
  sub: idSchema,
  role: roleSchema,
  /** Teams the user belongs to. */
  teams: z.array(idSchema).max(MAX_TEAM_CLAIMS),
  /** Teams the user manages (managers only; empty for everyone else). */
  managedTeams: z.array(idSchema).max(MAX_TEAM_CLAIMS),
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});
export type AccessTokenClaims = z.infer<typeof accessTokenClaimsSchema>;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Emails are compared case-insensitively, so they are normalised at the boundary. */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const displayNameSchema = z.string().trim().min(1).max(100);

export const userStatusSchema = z.enum(['active', 'disabled']);

export const userResponseSchema = z.strictObject({
  id: idSchema,
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: userStatusSchema,
});
export type UserResponse = z.infer<typeof userResponseSchema>;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  // Not length-checked on login: that would reveal the password policy to an attacker.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Returned by login and refresh. The refresh token travels only in an httpOnly cookie. */
export const sessionResponseSchema = z.strictObject({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: userResponseSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const createUserRequestSchema = z.strictObject({
  email: emailSchema,
  displayName: displayNameSchema,
  role: roleSchema,
  password: passwordSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/** Change a user's role and/or status. At least one must be provided. */
export const updateUserRequestSchema = z
  .strictObject({
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: 'Provide a role, a status, or both',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const createTeamRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  managerUserId: idSchema,
});
export type CreateTeamRequest = z.infer<typeof createTeamRequestSchema>;

export const teamResponseSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  managerUserId: idSchema,
  memberCount: z.number().int().min(0),
});
export type TeamResponse = z.infer<typeof teamResponseSchema>;

export const addTeamMemberRequestSchema = z.strictObject({
  userId: idSchema,
});
export type AddTeamMemberRequest = z.infer<typeof addTeamMemberRequestSchema>;

export const teamMemberResponseSchema = z.strictObject({
  id: idSchema,
  displayName: z.string(),
});
export type TeamMemberResponse = z.infer<typeof teamMemberResponseSchema>;

export const listUsersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(200).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const userListResponseSchema = z.strictObject({
  items: z.array(userResponseSchema),
  /** Opaque. Pass it back as `cursor` to get the next page; absent on the last page. */
  nextCursor: z.string().optional(),
});
export type UserListResponse = z.infer<typeof userListResponseSchema>;

export const teamListResponseSchema = z.strictObject({ items: z.array(teamResponseSchema) });
export type TeamListResponse = z.infer<typeof teamListResponseSchema>;

export const teamMemberListResponseSchema = z.strictObject({
  items: z.array(teamMemberResponseSchema),
});
export type TeamMemberListResponse = z.infer<typeof teamMemberListResponseSchema>;

/** RFC 7517 JSON Web Key Set. Public keys only. */
export const jwksResponseSchema = z.strictObject({
  keys: z.array(z.record(z.string(), z.unknown())),
});
export type JwksResponse = z.infer<typeof jwksResponseSchema>;
