<script lang="ts">
  import { activityTypes } from '@teampulse/contracts';
  import { onMount } from 'svelte';
  import { useApp } from '../../../../lib/context.js';
  import { TeamAnalytics } from '../../../../lib/features/analytics.svelte.js';
  import { titleCase } from '../../../../lib/format.js';

  const { api, session } = useApp();
  const organisation = session.isAdmin;
  const team = new TeamAnalytics(api.insight, organisation ? 'organization' : 'team');

  let teams = $state<{ id: string; name: string }[]>([]);

  onMount(async () => {
    if (!organisation) {
      try {
        teams = (await api.identity.teams()).items.map((t) => ({ id: t.id, name: t.name }));
        team.teamId = teams[0]?.id ?? '';
      } catch {
        teams = [];
      }
    }
    void team.load();
  });

  let started = false;
  $effect(() => {
    void team.from;
    void team.to;
    void team.teamId;
    if (started) void team.load();
    started = true;
  });

  const report = $derived(team.report.value);
</script>

<svelte:head><title>{organisation ? 'Organisation' : 'Team'} activity · TeamPulse</title></svelte:head>

<h1>{organisation ? 'Organisation activity' : 'Team activity'}</h1>
<p class="muted">
  Aggregated numbers only. A number is hidden when fewer than {report?.minCohortSize ?? 5} people are behind it, so nobody can be picked out.
</p>

<form class="row" onsubmit={(e) => e.preventDefault()}>
  {#if !organisation}
    <label class="field">Team
      <select bind:value={team.teamId}>{#each teams as t (t.id)}<option value={t.id}>{t.name}</option>{/each}</select>
    </label>
  {/if}
  <label class="field">From <input type="date" max={team.to} bind:value={team.from} /></label>
  <label class="field">To <input type="date" min={team.from} bind:value={team.to} /></label>
</form>

{#if team.report.error}
  <p class="notice error" role="alert">{team.report.error}</p>
{:else if report}
  {#if team.totalHidden}
    <p class="notice" role="status">Not enough participants in this period to show numbers without identifying people. Try a longer period.</p>
  {:else if report.total.suppressed === false}
    <h2>{report.total.completions} activities by {report.total.participants} people</h2>
    <div class="card"><tp-trend-chart series={team.series} from={team.from} to={team.to} label="Activities per day"></tp-trend-chart></div>
    {#if team.hiddenDays > 0}
      <p class="muted">{team.hiddenDays} day(s) are not shown because too few people took part.</p>
    {/if}
    <h2>By type</h2>
    <ul>
      {#each activityTypes.filter((t) => report.byActivityType[t] !== undefined) as type (type)}
        {@const cell = report.byActivityType[type]}
        <li>{titleCase(type)}: {cell && !cell.suppressed ? `${cell.completions} (${cell.participants} people)` : 'not enough participants to show'}</li>
      {/each}
    </ul>
  {/if}
{:else}
  <p class="muted">Loading…</p>
{/if}
