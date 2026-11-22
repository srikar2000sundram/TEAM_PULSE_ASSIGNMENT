# ADR-0008: Web components and design tokens

**Status:** Proposed

## Context

The case study asks for "reusable web components" (leaderboard, progress ring, progress card,
trend chart) and notes that "design tokens must be governed centrally".

## Decision

- Components live in `packages/ui`, authored as Svelte 5 components and compiled as **custom
  elements** (`<svelte:options customElement="tp-progress-ring" />`), with prefix `tp-`.
- Components are **presentational**: data in via props, actions out via DOM events.
- All visual values come from **CSS custom properties** (`--tp-*`) defined in one tokens file,
  which crosses the shadow DOM boundary. Components never hard-code colours or spacing.
- The tokens file has one owner and changes go through review.
- The app also imports the same components, so there is one implementation.

## Alternatives considered

| Option                       | Why not                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| Plain Svelte components only | Not reusable outside Svelte hosts; loses the "web component" requirement |
| Lit or Stencil               | Adds a second component technology to the frontend                       |
| Tailwind utility classes     | Utility classes do not pass through shadow DOM                           |

## Consequences

- (+) Framework-neutral, encapsulated styling, one source of visual truth.
- (-) Shadow DOM complicates global CSS, forms and some accessibility patterns; we test
  keyboard and screen reader behaviour per component.
- (-) Object props on custom elements need property (not attribute) binding; documented in the
  `packages/ui` README.
