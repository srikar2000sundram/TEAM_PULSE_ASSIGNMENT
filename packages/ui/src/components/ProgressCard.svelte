<svelte:options
  customElement={{
    tag: 'tp-progress-card',
    shadow: 'open',
    props: {
      title: { type: 'String' },
      value: { type: 'Number' },
      target: { type: 'Number' },
      trend: { type: 'String' },
    },
  }}
/>

<script lang="ts">
  import { fraction } from '../lib/geometry.js';

  let {
    title = '',
    value = 0,
    target = 0,
    trend = 'flat',
  }: { title?: string; value?: number; target?: number; trend?: string } = $props();

  const element = $host();
  const share = $derived(fraction(value, target));
  // Words as well as a symbol, so the trend does not depend on colour or on seeing an arrow.
  const trendText = $derived(
    trend === 'up' ? '▲ rising' : trend === 'down' ? '▼ falling' : '▬ steady',
  );

  function select() {
    element.dispatchEvent(new CustomEvent('select', { detail: { title }, bubbles: true, composed: true }));
  }
</script>

<button type="button" class="card" onclick={select}>
  <span class="title">{title}</span>
  <span class="numbers"><strong>{value}</strong>{#if target > 0}<span class="of"> of {target}</span>{/if}</span>
  {#if target > 0}
    <span class="bar" aria-hidden="true"><span class="fill" style:width="{share * 100}%"></span></span>
  {/if}
  <span class="trend {trend}">{trendText}</span>
</button>

<style>
  .card { all: unset; box-sizing: border-box; display: flex; flex-direction: column; gap: var(--tp-space-2); padding: var(--tp-space-4); border: 1px solid var(--tp-color-border); border-radius: var(--tp-radius-2); background: var(--tp-color-surface); font-family: var(--tp-font-family); color: var(--tp-color-text); cursor: pointer; min-width: 12rem; }
  .card:focus-visible { outline: 3px solid var(--tp-color-focus); outline-offset: 2px; }
  .title { color: var(--tp-color-text-muted); font-size: var(--tp-font-size-1); }
  strong { font-size: var(--tp-font-size-3); }
  .of { color: var(--tp-color-text-muted); }
  .bar { display: block; height: 0.5rem; border-radius: 999px; background: var(--tp-color-track); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--tp-color-accent); }
  .trend { font-size: var(--tp-font-size-1); }
  .up { color: var(--tp-color-positive); }
  .down { color: var(--tp-color-negative); }
  .flat { color: var(--tp-color-text-muted); }
</style>
