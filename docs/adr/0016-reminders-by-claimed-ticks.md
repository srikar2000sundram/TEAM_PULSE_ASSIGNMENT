# ADR-0016: Habit reminders by claimed ticks

**Status:** Proposed

## Context

Habits can have a reminder: some days, at a local time, in a time zone. Something has to notice that
a reminder is due and create exactly one notification, with several instances of the service running,
across time zones and daylight saving changes, and without a reminder being lost during a short
outage or sent twice.

## Decision

**A timer inside the service, with the work claimed in the database.**

- Every instance ticks every 30 seconds. A tick lists the active reminders and, for each one,
  asks "is it due now?" in the reminder's own time zone (`Intl` and the platform time zone
  database, so daylight saving needs no arithmetic of ours).
- **Due window.** A reminder is due from its time until 15 minutes later. This is what makes a
  missed tick or a short outage harmless, while a reminder from hours ago is not delivered late.
- **Claim before sending.** The occurrence (habit, local date) is inserted into
  `reminder_occurrences` with `ON CONFLICT DO NOTHING`; only the instance whose insert took effect
  sends. The notification is also keyed by a source id derived from the same pair, so even a
  broken claim cannot create two notifications. The claim and the notification are in one
  transaction, so a failure leaves neither.
- **Switched off still claims,** so turning reminders back on does not deliver a stale one.
- Old occurrences are purged after 14 days.

## Alternatives considered

- **One scheduler per time zone and a job per reminder (EventBridge Scheduler).** Precise, but
  creates and deletes thousands of schedules as habits change, needs its own failure handling, and
  cannot be tested locally.
- **Leader election so only one instance ticks.** More moving parts than a database claim, and a
  stuck leader silently stops all reminders.
- **Cron in the database.** Ties delivery to the database and hides the time zone logic.

## Consequences

- A reminder arrives within roughly 30 seconds of its time (tick length), never before it.
- Each tick reads all active reminders. Fine for thousands; at larger scale index by day and zone.
- A reminder set to a time that does not exist on a daylight saving day (02:30 in the spring change)
  is skipped that day, since the local time never occurs.
- All instances do the same small amount of work every tick, which is cheap and needs no
  coordination beyond the database.
