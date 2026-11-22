<svelte:options
  customElement={{
    tag: 'tp-leaderboard',
    shadow: 'open',
    props: {
      rows: { type: 'Array' },
      highlightId: { type: 'String', attribute: 'highlight-id' },
      metric: { type: 'String' },
    },
  }}
/>

<script lang="ts" module>
  export interface LeaderboardRow {
    id: string;
    rank: number;
    label: string;
    value: number;
  }
</script>

<script lang="ts">
  let {
    rows = [],
    highlightId = '',
    metric = 'Points',
  }: { rows?: LeaderboardRow[]; highlightId?: string; metric?: string } = $props();

  const element = $host();

  function select(row: LeaderboardRow) {
    element.dispatchEvent(new CustomEvent('rowselect', { detail: row, bubbles: true, composed: true }));
  }
</script>

{#if rows.length === 0}
  <p class="empty">Nobody has scored yet.</p>
{:else}
  <table>
    <thead>
      <tr><th scope="col">Rank</th><th scope="col">Name</th><th scope="col" class="num">{metric}</th></tr>
    </thead>
    <tbody>
      {#each rows as row (row.id)}
        <tr class:me={row.id === highlightId} aria-current={row.id === highlightId ? 'true' : undefined}>
          <td>{row.rank}</td>
          <td><button type="button" onclick={() => select(row)}>{row.label}</button></td>
          <td class="num">{row.value}{#if row.id === highlightId}<span class="you"> (you)</span>{/if}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  table { width: 100%; border-collapse: collapse; font-family: var(--tp-font-family); color: var(--tp-color-text); }
  th, td { padding: var(--tp-space-2) var(--tp-space-3); text-align: left; border-bottom: 1px solid var(--tp-color-border); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  th { color: var(--tp-color-text-muted); font-size: var(--tp-font-size-1); font-weight: 600; }
  .me { background: var(--tp-color-surface); font-weight: 700; }
  button { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
  button:focus-visible { outline: 3px solid var(--tp-color-focus); outline-offset: 2px; }
  .empty { color: var(--tp-color-text-muted); font-family: var(--tp-font-family); }
</style>
