<script lang="ts">
  import { activityTypes } from '@teampulse/contracts';
  import { onMount } from 'svelte';
  import { useApp } from '../../../../lib/context.js';
  import { MyAnalytics } from '../../../../lib/features/analytics.svelte.js';
  import { titleCase } from '../../../../lib/format.js';

  const { api } = useApp();
  const mine = new MyAnalytics(api.insight);

  onMount(() => void mine.load());

  // Reload when the period changes. `load` ignores a response that a newer call has overtaken.
  let started = false;
  $effect(() => {
    void mine.from;
    void mine.to;
    if (started) void mine.load();
    started = true;
  });
</script>

<svelte:head><title>My activity · TeamPulse</title></svelte:head>

<h1>My activity</h1>
<p class="muted">Only you can see this page. Your manager sees team totals, never yours.</p>

<form class="row" onsubmit={(e) => e.preventDefault()}>
  <label class="field">From <input type="date" max={mine.to} bind:value={mine.from} /></label>
  <label class="field">To <input type="date" min={mine.from} bind:value={mine.to} /></label>
</form>

{#if mine.report.error}
  <p class="notice error" role="alert">{mine.report.error}</p>
{:else if mine.report.value}
  <h2>{mine.report.value.total} activities</h2>
  <div class="card"><tp-trend-chart series={mine.series} from={mine.from} to={mine.to} label="Activities per day"></tp-trend-chart></div>
  <h2>By type</h2>
  <ul>
    {#each activityTypes.filter((t) => mine.report.value?.byActivityType[t] !== undefined) as type (type)}
      <li>{titleCase(type)}: {mine.report.value.byActivityType[type]}</li>
    {/each}
  </ul>
{:else}
  <p class="muted">Loading…</p>
{/if}
