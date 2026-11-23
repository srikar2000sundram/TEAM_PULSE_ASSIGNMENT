/**
 * Who listens to what on the event bus. The local stack builds its queues and rules from this file;
 * the Terraform for AWS (roadmap step 11) describes the same routing. A test checks the service
 * entries against the handlers the services really register, so this cannot drift from the code.
 */

export const BUS_NAME = 'teampulse-bus';
export const REGION = 'eu-west-1';

/** Services that consume events, and the event types their handlers accept. */
export const SERVICE_QUEUES = {
  habit: ['UserDeleted', 'TeamMembershipChanged'],
  'event-tracking': ['HabitCreated', 'HabitUpdated', 'HabitArchived', 'UserDeleted'],
  notification: [
    'MilestoneReached',
    'BadgeAwarded',
    'ChallengeJoined',
    'ChallengeCompleted',
    'HabitCreated',
    'HabitUpdated',
    'HabitArchived',
    'UserDeleted',
  ],
  challenge: ['ActivityCompleted', 'TeamMembershipChanged', 'UserDeleted'],
  insight: ['ActivityCompleted', 'UserDeleted'],
  recommendation: ['ActivityCompleted', 'UserDeleted'],
};

/** Lambda functions. In AWS the rule invokes the function; locally a runner reads this queue. */
export const LAMBDA_QUEUES = {
  streak: {
    events: ['ActivityCompleted'],
    module: '/app/lambdas/streak/dist/handler.js',
    export: 'handler',
  },
  'badge-streak': {
    events: ['StreakUpdated'],
    module: '/app/lambdas/badge/dist/handler.js',
    export: 'handler',
  },
  'badge-totals': {
    events: ['ActivityCompleted'],
    module: '/app/lambdas/badge/dist/handler.js',
    export: 'totalsHandler',
  },
};

export const TABLES = {
  streaks: 'teampulse-streaks',
  aggregates: 'teampulse-insight-aggregates',
  personal: 'teampulse-insight-personal',
};

export const queueName = (name) => `teampulse-${name}`;
export const dlqName = (name) => `teampulse-${name}-dlq`;
export const ruleName = (name) => `teampulse-to-${name}`;

/** An EventBridge rule pattern that matches events of these types. */
export const patternFor = (eventTypes) => JSON.stringify({ 'detail-type': eventTypes });

/** Every queue with the events it receives, services and Lambdas together. */
export function allQueues() {
  return [
    ...Object.entries(SERVICE_QUEUES).map(([name, events]) => ({ name, events })),
    ...Object.entries(LAMBDA_QUEUES).map(([name, lambda]) => ({
      name: `lambda-${name}`,
      events: lambda.events,
    })),
  ];
}
