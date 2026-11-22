<svelte:options
  customElement={{
    tag: 'tp-trend-chart',
    shadow: 'open',
    props: {
      series: { type: 'Array' },
      from: { type: 'String' },
      to: { type: 'String' },
      label: { type: 'String' },
    },
  }}
/>

<script lang="ts">
  import { scaleSeries, type Point } from '../lib/geometry.js';

  let {
    series = [],
    from = '',
    to = '',
    label = 'Trend',
  }: { series?: Point[]; from?: string; to?: string; label?: string } = $props();

  const element = $host();
  const W = 320;
  const H = 140;
  const PAD = 16;
  const points = $derived(scaleSeries(series, W, H, PAD));
  const line = $derived(points.map((p) => `${p.x},${p.y}`).join(' '));
  const summary = $derived(
    series.length === 0
      ? 'No data in this period.'
      : `${series.length} days${from && to ? ` from ${from} to ${to}` : ''}, highest ${Math.max(...series.map((p) => p.value))}.`,
  );

  function select(point: Point) {
    element.dispatchEvent(
      new CustomEvent('pointselect', {
        detail: { date: point.date, value: point.value },
        bubbles: true,
        composed: true,
      }),
    );
  }
</script>

<figure>
  <figcaption>{label}</figcaption>
  {#if series.length === 0}
    <p class="empty">{summary}</p>
  {:else}
    <svg viewBox="0 0 {W} {H}" role="group" aria-label="{label}. {summary}">
      <line class="axis" x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} />
      <polyline class="line" points={line} />
      {#each points as point (point.date)}
        <circle
          class="dot"
          cx={point.x}
          cy={point.y}
          r="5"
          role="button"
          tabindex="0"
          aria-label="{point.date}: {point.value}"
          onclick={() => select(point)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              select(point);
            }
          }}
        />
      {/each}
    </svg>
    <!-- The same data as text: charts must not be the only way to read it. -->
    <details>
      <summary>Show as table</summary>
      <table>
        <thead><tr><th scope="col">Date</th><th scope="col">Value</th></tr></thead>
        <tbody>{#each series as point (point.date)}<tr><td>{point.date}</td><td>{point.value}</td></tr>{/each}</tbody>
      </table>
    </details>
  {/if}
</figure>

<style>
  figure { margin: 0; font-family: var(--tp-font-family); color: var(--tp-color-text); }
  figcaption { font-size: var(--tp-font-size-1); color: var(--tp-color-text-muted); margin-bottom: var(--tp-space-2); }
  svg { width: 100%; height: auto; display: block; }
  .axis { stroke: var(--tp-color-border); }
  .line { fill: none; stroke: var(--tp-color-accent); stroke-width: 2; }
  .dot { fill: var(--tp-color-accent); cursor: pointer; }
  .dot:focus-visible { outline: 3px solid var(--tp-color-focus); outline-offset: 2px; }
  details { margin-top: var(--tp-space-2); font-size: var(--tp-font-size-1); }
  table { border-collapse: collapse; }
  th, td { padding: var(--tp-space-1) var(--tp-space-3); text-align: left; border-bottom: 1px solid var(--tp-color-border); }
  .empty { color: var(--tp-color-text-muted); }
</style>
