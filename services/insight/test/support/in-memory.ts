import type {
  ActivityObservation,
  AnalyticsStore,
  Contribution,
} from '../../src/application/ports.js';
import type { CellData, PersonalDay } from '../../src/domain/report.js';

interface Counter {
  completions: number;
  people: Set<string>;
  scopes: Set<string>;
  expiresAt: Date;
}

const cellKey = (scopeKey: string, day: string, type: string) => `${scopeKey}|${day}|${type}`;

/** The same behaviour as the DynamoDB store, in memory. The shared contract suite proves it. */
export class InMemoryAnalyticsStore implements AnalyticsStore {
  private readonly markers = new Set<string>();
  private readonly cells = new Map<string, Counter>();
  private readonly personal = new Map<string, Counter>();
  /** Set to make every call fail, to test outage handling. */
  failWith: Error | undefined;

  record(observation: ActivityObservation): Promise<'recorded' | 'duplicate'> {
    this.check();
    if (this.markers.has(observation.eventId)) return Promise.resolve('duplicate');
    this.markers.add(observation.eventId);

    const personalKey = cellKey(observation.userId, observation.day, observation.activityType);
    const mine = this.personal.get(personalKey) ?? fresh(observation.expiresAt);
    mine.completions += 1;
    for (const c of observation.contributions) mine.scopes.add(c.scopeKey);
    this.personal.set(personalKey, mine);

    for (const c of observation.contributions) {
      const key = cellKey(c.scopeKey, observation.day, observation.activityType);
      const cell = this.cells.get(key) ?? fresh(observation.expiresAt);
      cell.completions += 1;
      cell.people.add(c.participant);
      this.cells.set(key, cell);
    }
    return Promise.resolve('recorded');
  }

  readCells(scopeKey: string, from: string, to: string): Promise<readonly CellData[]> {
    this.check();
    const result: CellData[] = [];
    for (const [key, cell] of this.cells) {
      const [scope, day, type] = key.split('|') as [string, string, CellData['activityType']];
      if (scope !== scopeKey || day < from || day > to) continue;
      if (cell.completions <= 0 || cell.people.size === 0) continue;
      result.push({
        day,
        activityType: type,
        completions: cell.completions,
        participants: [...cell.people],
      });
    }
    return Promise.resolve(result);
  }

  readPersonal(userId: string, from: string, to: string): Promise<readonly PersonalDay[]> {
    this.check();
    const result: PersonalDay[] = [];
    for (const [key, counter] of this.personal) {
      const [user, day, type] = key.split('|') as [string, string, PersonalDay['activityType']];
      if (user !== userId || day < from || day > to || counter.completions <= 0) continue;
      result.push({
        day,
        activityType: type,
        completions: counter.completions,
        scopeKeys: [...counter.scopes],
        expiresAt: counter.expiresAt,
      });
    }
    return Promise.resolve(result);
  }

  erasePersonalDay(
    userId: string,
    day: PersonalDay,
    contributions: readonly Contribution[],
  ): Promise<void> {
    this.check();
    const personalKey = cellKey(userId, day.day, day.activityType);
    if (!this.personal.delete(personalKey)) return Promise.resolve();
    for (const c of contributions) {
      const cell = this.cells.get(cellKey(c.scopeKey, day.day, day.activityType));
      if (cell === undefined) continue;
      cell.completions -= day.completions;
      cell.people.delete(c.participant);
    }
    return Promise.resolve();
  }

  ping(): Promise<void> {
    this.check();
    return Promise.resolve();
  }

  clear(): void {
    this.markers.clear();
    this.cells.clear();
    this.personal.clear();
    this.failWith = undefined;
  }

  /** Every stored string, for tests that assert something is never stored. */
  dumpCells(): string {
    return JSON.stringify([...this.cells].map(([key, c]) => [key, c.completions, [...c.people]]));
  }

  private check(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }
}

function fresh(expiresAt: Date): Counter {
  return { completions: 0, people: new Set(), scopes: new Set(), expiresAt };
}
