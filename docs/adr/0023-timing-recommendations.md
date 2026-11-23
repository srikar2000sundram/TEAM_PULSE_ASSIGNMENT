# ADR-0023: Timing recommendations from a histogram, accepted through the habit's reminder

**Status:** Proposed

## Context

The brief asks for a Recommendation microservice: a Recommendations page that shows a personalised
timing recommendation which the user can accept. The data to base it on is the time of day at which a
person completes their habits. We need a service that is explainable, testable, private, and fits the
event-driven design already in place.

## Decision

- **A separate service** (`recommendation`, own schema, own queue), because it has its own data
  (completion times, decisions) and its own lifecycle, like the other services.
- **It learns from `ActivityCompleted`.** The event's `occurredAt` is the time the person pressed
  "done", so no contract change is needed. Only the event id, user, habit and instant are stored. No
  habit title or other free text (ADR-0005).
- **The algorithm is a histogram of local completion hours** over the last 60 days: the busiest hour
  wins when there are at least 5 completions and it holds at least 40 % of them. Pure function,
  deterministic tie-break.
- **Computed on demand.** There is no stored recommendation to invalidate when new activity arrives.
  The only stored judgement is the person's **decision** (accepted or dismissed) about a specific
  suggestion (habit, time, zone), so a later, different suggestion is not hidden by an old decision.
- **The time zone comes from the caller.** The service does not know where a person is; the browser
  sends its zone with each request. The hour is computed with the platform time zone database.
- **Accepting is two steps, orchestrated by the web app:** record the decision, then `PATCH` the habit's
  reminder through the Habit API with the person's own token. The Habit and Notification services
  already turn a reminder into daily notifications, so the recommendation has a real effect without a
  new integration between services.
- **Personal only.** Every endpoint returns the caller's own data. There is no team or manager view.

## Alternatives considered

- **Machine-learning model.** Not explainable to a person or a reviewer, hard to test, and needs far
  more data than a habit app has per person.
- **Store the time in the Habit or Event Tracking service.** Couples two services to a feature neither
  owns, and would need a contract change.
- **The Recommendation service calls the Habit service when a recommendation is accepted.** Needs
  service-to-service authentication and a way to act on a person's behalf. The web app already holds
  the person's token, so it is simpler and no less safe.
- **Publish a `RecommendationAccepted` event for the Habit service to apply.** Cleaner in theory,
  but adds an event, a handler and an ordering question for little gain at this size.

## Consequences

- Accepting is not atomic across two services. If the reminder update fails after the decision was
  stored, the person sees an error and the recommendation shows as accepted; they can set the reminder
  by hand. Acceptable for a convenience feature.
- Recommendations only improve with use: nothing is shown until a habit has 5 completions, which is
  stated on the page.
- A person who travels sees recommendations in whichever zone their browser reports.
- Completions older than 60 days are deleted by a timer, which also bounds the personal data kept.
