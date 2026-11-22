import type { MyActivityReport, TeamActivityReport } from '@teampulse/contracts';
import { AsyncValue } from '../async.svelte.js';
import type { InsightApi } from '../api/index.js';
import { daysAgo, localDate } from '../format.js';

export interface ChartSeriesPoint {
  readonly date: string;
  readonly value: number;
}

/** Your own numbers for a period. */
export class MyAnalytics {
  readonly report = new AsyncValue<MyActivityReport>();
  from = $state(daysAgo(29));
  to = $state(localDate());

  series = $derived<ChartSeriesPoint[]>(
    (this.report.value?.byDay ?? []).map((d) => ({ date: d.date, value: d.completions })),
  );

  constructor(private readonly api: InsightApi) {}

  load = () => this.report.load(() => this.api.me({ from: this.from, to: this.to }));
}

/** A team's (or the organisation's) aggregate numbers, with small groups hidden by the server. */
export class TeamAnalytics {
  readonly report = new AsyncValue<TeamActivityReport>();
  teamId = $state('');
  from = $state(daysAgo(29));
  to = $state(localDate());

  /** Days that may be shown, as chart points. Hidden days are left out, never drawn as zero. */
  series = $derived<ChartSeriesPoint[]>(
    (this.report.value?.byDay ?? []).flatMap(({ date, cell }) =>
      cell.suppressed ? [] : [{ date, value: cell.completions }],
    ),
  );

  hiddenDays = $derived(
    (this.report.value?.byDay ?? []).filter(({ cell }) => cell.suppressed).length,
  );
  totalHidden = $derived(this.report.value?.total.suppressed ?? false);

  constructor(
    private readonly api: InsightApi,
    private readonly scope: 'team' | 'organization' = 'team',
  ) {}

  load = () =>
    this.report.load(() =>
      this.scope === 'organization'
        ? this.api.organization({ from: this.from, to: this.to })
        : this.api.team(this.teamId, { from: this.from, to: this.to }),
    );
}
