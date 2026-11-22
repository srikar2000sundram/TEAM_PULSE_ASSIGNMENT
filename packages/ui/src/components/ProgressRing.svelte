<svelte:options
  customElement={{
    tag: 'tp-progress-ring',
    shadow: 'open',
    props: {
      value: { type: 'Number' },
      max: { type: 'Number' },
      label: { type: 'String' },
      size: { type: 'Number' },
    },
  }}
/>

<script lang="ts">
  import { fraction, ringGeometry } from '../lib/geometry.js';

  let {
    value = 0,
    max = 100,
    label = '',
    size = 96,
  }: { value?: number; max?: number; label?: string; size?: number } = $props();

  const STROKE = 10;
  const share = $derived(fraction(value, max));
  const ring = $derived(ringGeometry(size, STROKE, share));
  // The numbers are always shown: colour and length are never the only signal.
  const text = $derived(`${Math.round(value)} / ${Math.round(max)}`);
</script>

<div
  class="ring"
  role="progressbar"
  aria-label={label || 'Progress'}
  aria-valuemin="0"
  aria-valuemax={max}
  aria-valuenow={Math.min(value, max)}
  aria-valuetext={text}
  style:width="{size}px"
  style:height="{size}px"
>
  <svg width={size} height={size} viewBox="0 0 {size} {size}" aria-hidden="true">
    <circle class="track" cx={ring.center} cy={ring.center} r={ring.radius} stroke-width={STROKE} />
    <circle
      class="fill"
      cx={ring.center}
      cy={ring.center}
      r={ring.radius}
      stroke-width={STROKE}
      stroke-dasharray={ring.circumference}
      stroke-dashoffset={ring.offset}
      transform="rotate(-90 {ring.center} {ring.center})"
    />
  </svg>
  <span class="text">
    <strong>{text}</strong>
    {#if label}<small>{label}</small>{/if}
  </span>
</div>

<style>
  .ring { position: relative; display: inline-block; font-family: var(--tp-font-family); color: var(--tp-color-text); }
  svg { display: block; }
  circle { fill: none; }
  .track { stroke: var(--tp-color-track); }
  .fill { stroke: var(--tp-color-accent); stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
  .text { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; font-size: var(--tp-font-size-1); }
  small { color: var(--tp-color-text-muted); }
  @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
</style>
