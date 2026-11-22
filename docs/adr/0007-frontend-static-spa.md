# ADR-0007: Frontend as a static SPA on S3 and CloudFront

**Status:** Proposed

## Context

The case study hosts the frontend on Amazon S3 with global low-latency distribution, and requires
SvelteKit with runes.

## Decision

- SvelteKit with **`adapter-static`** in SPA mode (fallback `index.html`), `ssr = false`.
- Hosted in a **private S3 bucket** served only through **CloudFront** (origin access control).
- Hashed asset filenames get long cache lifetimes; `index.html` is not cached; deployments
  invalidate `/index.html`.
- All data comes from the REST APIs; the browser holds only the access token in memory.

## Alternatives considered

| Option               | Why not                                                   |
| -------------------- | --------------------------------------------------------- |
| SvelteKit SSR on ECS | Contradicts the S3 hosting requirement and adds a service |
| Public S3 website    | No HTTPS on custom domain, no WAF, bucket must be public  |

## Consequences

- (+) Cheap, fast, highly available, no servers to operate.
- (-) No server-side rendering: first paint depends on JS; acceptable for an authenticated
  internal dashboard (no SEO need).
- (-) Route guards in the browser are not security; the APIs enforce access.
