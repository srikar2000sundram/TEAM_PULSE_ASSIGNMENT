<script lang="ts">
  import { onMount } from 'svelte';
  import { useApp } from '../../../lib/context.js';
  import { RecommendationsState } from '../../../lib/features/recommendations.svelte.js';

  const { api } = useApp();
  const recommendations = new RecommendationsState(api.recommendations, api.habits);

  onMount(() => void recommendations.load());

  const CONFIDENCE: Record<string, string> = {
    high: 'Strong pattern',
    medium: 'Clear pattern',
    low: 'Tentative',
  };
</script>

<svelte:head><title>Recommendations · TeamPulse</title></svelte:head>

<h1>Recommendations</h1>
<p class="muted">
  When you usually do each habit, from your own history. Accept one to get a daily reminder at that
  time. Only you can see this page.
</p>

{#if recommendations.notice}
  <p class="notice {recommendations.notice.kind}" role={recommendations.notice.kind === 'error' ? 'alert' : 'status'}>
    {recommendations.notice.text}
  </p>
{/if}

{#if recommendations.items.loading && !recommendations.items.value}
  <p class="muted">Loading…</p>
{:else if recommendations.items.error}
  <p class="notice error" role="alert">{recommendations.items.error}</p>
{:else if (recommendations.items.value ?? []).length === 0}
  <p class="muted">
    No recommendations yet. Record a habit on at least five days and a pattern will appear here.
  </p>
{:else}
  <ul class="stack" style="list-style: none; padding: 0">
    {#each recommendations.items.value ?? [] as item (item.habitId)}
      <li class="card row">
        <div style="flex: 1">
          <strong>{item.habitTitle}</strong>
          <div>
            Best time: <strong>{item.suggestedTime}</strong>
            <span class="muted">({item.timeZone})</span>
          </div>
          <div class="muted">
            {CONFIDENCE[item.confidence]} · {item.matching} of your last {item.sampleSize} were around this time
          </div>
        </div>
        {#if item.status === 'pending'}
          <button class="primary" type="button" disabled={recommendations.busy} onclick={() => recommendations.accept(item)}>
            Accept
          </button>
          <button class="secondary" type="button" disabled={recommendations.busy} onclick={() => recommendations.dismiss(item)}>
            Dismiss
          </button>
        {:else}
          <span class="muted">{item.status === 'accepted' ? 'Accepted' : 'Dismissed'}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
