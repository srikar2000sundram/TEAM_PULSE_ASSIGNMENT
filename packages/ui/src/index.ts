/**
 * Importing this module registers the custom elements (tp-progress-ring, tp-progress-card,
 * tp-leaderboard, tp-trend-chart, tp-filter-bar). Pair it with `@teampulse/ui/tokens.css`.
 */
import './components/ProgressRing.svelte';
import './components/ProgressCard.svelte';
import './components/Leaderboard.svelte';
import './components/TrendChart.svelte';
import './components/FilterBar.svelte';

export { clamp, fraction, ringGeometry, scaleSeries } from './lib/geometry.js';
export type { Point, ChartPoint, RingGeometry } from './lib/geometry.js';
