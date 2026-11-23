import {
  activityResponseSchema,
  challengeListResponseSchema,
  challengeProgressResponseSchema,
  challengeResponseSchema,
  habitListResponseSchema,
  habitResponseSchema,
  leaderboardResponseSchema,
  myActivityReportSchema,
  notificationListResponseSchema,
  notificationResponseSchema,
  decisionResponseSchema,
  recommendationListResponseSchema,
  sessionResponseSchema,
  teamActivityReportSchema,
  teamListResponseSchema,
  teamMemberListResponseSchema,
  teamResponseSchema,
  userListResponseSchema,
  userResponseSchema,
  type ActivityResponse,
  type ChallengeListResponse,
  type ChallengeProgressResponse,
  type ChallengeResponse,
  type ChallengeStatus,
  type CreateChallengeRequest,
  type CreateHabitRequest,
  type CreateTeamRequest,
  type CreateUserRequest,
  type DecideRecommendationRequest,
  type DecisionResponse,
  type HabitListResponse,
  type HabitResponse,
  type LeaderboardResponse,
  type MyActivityReport,
  type NotificationListResponse,
  type NotificationResponse,
  type RecommendationListResponse,
  type UpdateHabitRequest,
  type SessionResponse,
  type TeamActivityReport,
  type TeamListResponse,
  type TeamMemberListResponse,
  type TeamResponse,
  type UpdateUserRequest,
  type UserListResponse,
  type UserResponse,
} from '@teampulse/contracts';
import { FetchHttpClient, type HttpClient, type TokenSource } from './http.js';

export interface Period {
  readonly from: string;
  readonly to: string;
}

/*
 * One interface per backend service. Features depend on these, never on fetch, so tests supply
 * fakes (Dependency Inversion). The implementations below are the only code that knows URLs.
 */

export interface IdentityApi {
  login(email: string, password: string): Promise<SessionResponse>;
  refresh(): Promise<SessionResponse>;
  logout(): Promise<void>;
  teams(): Promise<TeamListResponse>;
  teamMembers(teamId: string): Promise<TeamMemberListResponse>;
}

/** Administrator-only operations of the Identity service. */
export interface AdminApi {
  users(query: { limit?: number; cursor?: string }): Promise<UserListResponse>;
  createUser(request: CreateUserRequest): Promise<UserResponse>;
  updateUser(userId: string, request: UpdateUserRequest): Promise<UserResponse>;
  createTeam(request: CreateTeamRequest): Promise<TeamResponse>;
  addTeamMember(teamId: string, userId: string): Promise<void>;
}

export interface HabitApi {
  list(query: { status?: 'active' | 'archived'; limit?: number }): Promise<HabitListResponse>;
  create(request: CreateHabitRequest): Promise<HabitResponse>;
  archive(habitId: string): Promise<HabitResponse>;
  update(habitId: string, request: UpdateHabitRequest): Promise<HabitResponse>;
}

export interface ActivityApi {
  record(habitId: string, activityDate: string): Promise<ActivityResponse>;
}

export interface ChallengeApi {
  list(query: { status?: ChallengeStatus; limit?: number }): Promise<ChallengeListResponse>;
  get(challengeId: string): Promise<ChallengeResponse>;
  create(request: CreateChallengeRequest): Promise<ChallengeResponse>;
  start(challengeId: string): Promise<ChallengeResponse>;
  cancel(challengeId: string): Promise<ChallengeResponse>;
  join(challengeId: string): Promise<ChallengeResponse>;
  leaderboard(challengeId: string): Promise<LeaderboardResponse>;
  progress(challengeId: string): Promise<ChallengeProgressResponse>;
}

export interface InsightApi {
  team(teamId: string, period: Period): Promise<TeamActivityReport>;
  organization(period: Period): Promise<TeamActivityReport>;
  me(period: Period): Promise<MyActivityReport>;
}

export interface NotificationApi {
  list(query: { unread?: boolean; limit?: number }): Promise<NotificationListResponse>;
  markRead(notificationId: string): Promise<NotificationResponse>;
}

export interface RecommendationApi {
  list(timeZone: string): Promise<RecommendationListResponse>;
  accept(habitId: string, request: DecideRecommendationRequest): Promise<DecisionResponse>;
  dismiss(habitId: string, request: DecideRecommendationRequest): Promise<DecisionResponse>;
}

export interface Api {
  readonly identity: IdentityApi;
  readonly admin: AdminApi;
  readonly habits: HabitApi;
  readonly activities: ActivityApi;
  readonly challenges: ChallengeApi;
  readonly insight: InsightApi;
  readonly notifications: NotificationApi;
  readonly recommendations: RecommendationApi;
}

const BASE = '/api/v1';

/** The real implementations, over HTTP. `origin` is empty when the app and the APIs share an origin. */
export function createApi(
  tokens: TokenSource,
  options: {
    origin?: string;
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  } = {},
): Api {
  const origin = options.origin ?? '';
  const client = (service: string): HttpClient =>
    new FetchHttpClient(`${origin}${BASE}/${service}`, tokens, options.fetch);

  const identity = client('identity');
  const habit = client('habit');
  const tracking = client('event-tracking');
  const challenge = client('challenge');
  const insight = client('insight');
  const notification = client('notification');
  const recommendation = client('recommendation');
  const enc = encodeURIComponent;

  return {
    identity: {
      login: (email, password) =>
        identity.request({
          method: 'POST',
          path: '/auth/login',
          body: { email, password },
          schema: sessionResponseSchema,
          cookieAuth: true,
        }),
      refresh: () =>
        identity.request({
          method: 'POST',
          path: '/auth/refresh',
          schema: sessionResponseSchema,
          cookieAuth: true,
        }),
      logout: () => identity.request({ method: 'POST', path: '/auth/logout', cookieAuth: true }),
      teams: () =>
        identity.request({ method: 'GET', path: '/teams', schema: teamListResponseSchema }),
      teamMembers: (teamId) =>
        identity.request({
          method: 'GET',
          path: `/teams/${enc(teamId)}/members`,
          schema: teamMemberListResponseSchema,
        }),
    },
    admin: {
      users: (query) =>
        identity.request({ method: 'GET', path: '/users', query, schema: userListResponseSchema }),
      createUser: (request) =>
        identity.request({
          method: 'POST',
          path: '/users',
          body: request,
          schema: userResponseSchema,
        }),
      updateUser: (userId, request) =>
        identity.request({
          method: 'PATCH',
          path: `/users/${enc(userId)}`,
          body: request,
          schema: userResponseSchema,
        }),
      createTeam: (request) =>
        identity.request({
          method: 'POST',
          path: '/teams',
          body: request,
          schema: teamResponseSchema,
        }),
      addTeamMember: (teamId, userId) =>
        identity.request({
          method: 'POST',
          path: `/teams/${enc(teamId)}/members`,
          body: { userId },
        }),
    },
    habits: {
      list: (query) =>
        habit.request({ method: 'GET', path: '/habits', query, schema: habitListResponseSchema }),
      create: (request) =>
        habit.request({
          method: 'POST',
          path: '/habits',
          body: request,
          schema: habitResponseSchema,
        }),
      archive: (habitId) =>
        habit.request({
          method: 'POST',
          path: `/habits/${enc(habitId)}/archive`,
          schema: habitResponseSchema,
        }),
      update: (habitId, request) =>
        habit.request({
          method: 'PATCH',
          path: `/habits/${enc(habitId)}`,
          body: request,
          schema: habitResponseSchema,
        }),
    },
    activities: {
      record: (habitId, activityDate) =>
        tracking.request({
          method: 'POST',
          path: '/activities',
          body: { habitId, activityDate },
          schema: activityResponseSchema,
        }),
    },
    challenges: {
      list: (query) =>
        challenge.request({
          method: 'GET',
          path: '/challenges',
          query,
          schema: challengeListResponseSchema,
        }),
      get: (id) =>
        challenge.request({
          method: 'GET',
          path: `/challenges/${enc(id)}`,
          schema: challengeResponseSchema,
        }),
      create: (request) =>
        challenge.request({
          method: 'POST',
          path: '/challenges',
          body: request,
          schema: challengeResponseSchema,
        }),
      start: (id) =>
        challenge.request({
          method: 'POST',
          path: `/challenges/${enc(id)}/start`,
          schema: challengeResponseSchema,
        }),
      cancel: (id) =>
        challenge.request({
          method: 'POST',
          path: `/challenges/${enc(id)}/cancel`,
          schema: challengeResponseSchema,
        }),
      join: (id) =>
        challenge.request({
          method: 'POST',
          path: `/challenges/${enc(id)}/join`,
          schema: challengeResponseSchema,
        }),
      leaderboard: (id) =>
        challenge.request({
          method: 'GET',
          path: `/challenges/${enc(id)}/leaderboard`,
          schema: leaderboardResponseSchema,
        }),
      progress: (id) =>
        challenge.request({
          method: 'GET',
          path: `/challenges/${enc(id)}/progress`,
          schema: challengeProgressResponseSchema,
        }),
    },
    insight: {
      team: (teamId, period) =>
        insight.request({
          method: 'GET',
          path: `/teams/${enc(teamId)}/activity`,
          query: { ...period },
          schema: teamActivityReportSchema,
        }),
      organization: (period) =>
        insight.request({
          method: 'GET',
          path: '/organization/activity',
          query: { ...period },
          schema: teamActivityReportSchema,
        }),
      me: (period) =>
        insight.request({
          method: 'GET',
          path: '/me/activity',
          query: { ...period },
          schema: myActivityReportSchema,
        }),
    },
    notifications: {
      list: (query) =>
        notification.request({
          method: 'GET',
          path: '/notifications',
          query,
          schema: notificationListResponseSchema,
        }),
      markRead: (id) =>
        notification.request({
          method: 'POST',
          path: `/notifications/${enc(id)}/read`,
          schema: notificationResponseSchema,
        }),
    },
    recommendations: {
      list: (timeZone) =>
        recommendation.request({
          method: 'GET',
          path: '/recommendations',
          query: { timeZone },
          schema: recommendationListResponseSchema,
        }),
      accept: (habitId, request) =>
        recommendation.request({
          method: 'POST',
          path: `/recommendations/${enc(habitId)}/accept`,
          body: request,
          schema: decisionResponseSchema,
        }),
      dismiss: (habitId, request) =>
        recommendation.request({
          method: 'POST',
          path: `/recommendations/${enc(habitId)}/dismiss`,
          body: request,
          schema: decisionResponseSchema,
        }),
    },
  };
}
