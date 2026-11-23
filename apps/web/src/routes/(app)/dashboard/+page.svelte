<script lang="ts">
  import { onMount } from 'svelte';
  import { useApp } from '../../../lib/context.js';
  import { MyAnalytics } from '../../../lib/features/analytics.svelte.js';
  import { daysAgo, localDate } from '../../../lib/format.js';

  const { api, session } = useApp();

  const mine = new MyAnalytics(api.insight);
  mine.from = daysAgo(6);
  mine.to = localDate();
  onMount(() => void mine.load());

  const activeDays = $derived(mine.report.value?.byDay.length ?? 0);
  const total = $derived(mine.report.value?.total ?? 0);
</script>

<svelte:head><title>Dashboard · TeamPulse</title></svelte:head>

<h1>Hello, {session.user?.displayName}</h1>
<p class="muted">Here is how your week is going.</p>

{#if mine.report.error}
  <p class="notice error" role="alert">{mine.report.error}</p>
{/if}

<h2>Your last 7 days</h2>
<div class="grid">
  <div class="card row">
    <tp-progress-ring value={activeDays} max={7} label="active days"></tp-progress-ring>
  </div>
  <tp-progress-card title="Activities completed" value={total} target={0} trend="flat" onselect={() => (location.href = '/analytics/me')}></tp-progress-card>
</div>

<h2>Trend</h2>
<div class="card">
  <tp-trend-chart series={mine.series} from={mine.from} to={mine.to} label="Your activities per day"></tp-trend-chart>
</div>

<p class="muted">
  Managers and administrators see only aggregated team numbers, never an individual's activity.
</p>
