import type { BadgeKind, NotificationKind, NotificationPreferences } from '@teampulse/contracts';

/**
 * What a notification is about, as data. The wording is produced from this when it is read, so
 * texts can change (or be translated) without touching stored notifications, and nothing a person
 * wrote can end up in a notification: events carry no habit titles or free text.
 */
export type NotificationContent =
  | {
      readonly kind: 'milestone';
      readonly milestoneKind: 'streak' | 'total';
      readonly threshold: number;
    }
  | { readonly kind: 'badge'; readonly badgeKind: BadgeKind }
  | { readonly kind: 'challenge_completed' }
  | { readonly kind: 'reminder' };

/** The preference a kind of notification falls under. */
export function categoryOf(kind: NotificationKind): keyof NotificationPreferences {
  switch (kind) {
    case 'milestone':
      return 'milestones';
    case 'badge':
      return 'badges';
    case 'challenge_completed':
      return 'challenges';
    case 'reminder':
      return 'reminders';
  }
}

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

const BADGE_NAMES: Readonly<Record<BadgeKind, string>> = {
  streak: 'streak',
  total: 'activity',
  milestone: 'milestone',
};

export function render(content: NotificationContent): RenderedNotification {
  switch (content.kind) {
    case 'milestone':
      return content.milestoneKind === 'streak'
        ? {
            title: 'Streak milestone',
            body: `You kept a habit going for ${content.threshold} days in a row. Well done!`,
          }
        : {
            title: 'Activity milestone',
            body: `You have completed ${content.threshold} activities. Well done!`,
          };
    case 'badge':
      return {
        title: 'New badge',
        body: `You earned a ${BADGE_NAMES[content.badgeKind]} badge in a challenge.`,
      };
    case 'challenge_completed':
      return {
        title: 'Challenge finished',
        body: 'A challenge you joined has finished. See the final standings.',
      };
    case 'reminder':
      // Generic on purpose: the reminder event carries no habit title (ADR-0005).
      return { title: 'Time for your habit', body: 'It is time to do one of your habits.' };
  }
}

export interface NotificationProps {
  readonly id: string;
  readonly userId: string;
  readonly content: NotificationContent;
  /** The event (or reminder) that caused it. With the user it makes delivery idempotent. */
  readonly sourceId: string;
  readonly createdAt: Date;
  readonly readAt: Date | null;
}

/** Immutable: marking as read returns a new Notification. */
export class Notification {
  private constructor(private readonly props: NotificationProps) {}

  static create(
    input: Omit<NotificationProps, 'readAt' | 'createdAt'> & { now: Date },
  ): Notification {
    const { now, ...rest } = input;
    return new Notification({ ...rest, createdAt: now, readAt: null });
  }

  /** Rebuilds a notification from stored state. Used by repositories only. */
  static restore(props: NotificationProps): Notification {
    return new Notification(props);
  }

  get id(): string {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get content(): NotificationContent {
    return this.props.content;
  }
  get kind(): NotificationKind {
    return this.props.content.kind;
  }
  get sourceId(): string {
    return this.props.sourceId;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get readAt(): Date | null {
    return this.props.readAt;
  }
  get isRead(): boolean {
    return this.props.readAt !== null;
  }

  /** Idempotent: the first read time is kept. */
  markRead(now: Date): Notification {
    return this.isRead ? this : new Notification({ ...this.props, readAt: now });
  }
}

/** Everything is on until a person switches a category off. */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  milestones: true,
  badges: true,
  challenges: true,
  reminders: true,
};

export const isEnabled = (preferences: NotificationPreferences, kind: NotificationKind): boolean =>
  preferences[categoryOf(kind)];
