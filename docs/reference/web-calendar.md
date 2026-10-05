# Web calendar surfaces — implementation reference

Relocated from `app/web/src/components/calendar/CLAUDE.md` (Task-274) so it
stops costing agent context on every visit. This is a descriptive snapshot of
what the modules in that subtree own; the rules an agent must not violate stay
in that folder's `CLAUDE.md`. Correct or delete a section here when the code
moves on. Relative paths in the body are relative to the original subtree.

## Purpose

Calendar UI components and date helpers for month/day agenda views and event
detail panels.

## Module ownership

- `CalendarPage.tsx` owns the calendar route page composition. Its toolbar row
  IS this page's header, so it renders the mobile screen back control itself
  (`PageHeaderBackButton` in place of the leading calendar glyph) instead of
  taking a `PageHeader`; a bare `/calendar` is the section index (the browser's
  view list), while `/calendar/:view/:date` is the calendar screen.
- `CalendarDetailPanel.tsx` renders through the shared `shell/Inspector` frame
  so it looks and behaves like every other right-panel inspector. No embedded
  agent, no custom close button (the shell owns dismissal). A selected calendar
  entry shows that Event (type label "Event", an Event section, and a "Back to
  day" action); with none selected the panel asks for one and offers **New
  session**.
- `MonthView.tsx`, `TimeGrid.tsx`, and `EventChip.tsx` own calendar
  visualization widgets. Tapping a day cell (month) or column/header (week)
  selects that day AND focuses it in the right detail panel via `CalendarPage`'s
  `onFocusDay` (App opens the inspector); the day-number circle is a separate
  control that jumps into Day view (`onOpenDay`).
- Tempo overlay: when the header **Tempo** toggle is on
  (`prefs.calendarShowTempo`, persisted), `useCalendar` fetches the visible
  range's OWN logged worklogs (`fetchCalendarWorklogs` → `worklogsByDay`,
  grouped by user-local `startDate`). `MonthView` shows a per-day logged-hours
  badge (emerald); `TimeGrid` renders a parallel right-hand Tempo track
  (`TempoBlock`, emerald, links to the Jira issue) while events keep the left
  ~68% of the column so overlaps stay readable. Worklog enrichment (issue
  key/url) needs Jira; the overlay simply shows nothing when Tempo is off
  (`idle`) or unauthorized.
- `calendarDates.ts` owns local date formatting/range helpers.
- Loading states (Task-361 phase 3a, model: `app/web/docs/loading-states.md`):
  `useCalendar` reports each of its two fetches as a `LoadState` from
  `hooks/useFetchState.ts` — `events` (key: the visible range) and `worklogs`
  (the range, fetched only while the overlay is on). A failed events fetch KEEPS
  the entries on screen under `CalendarPage`'s `ErrorNote`; moving the range
  reports `refreshing` and keeps the entries that still apply, because entries
  are addressed by day and can only paint days the new range also covers. The
  worklog fetch does not swallow its failure: it is an `ErrorNote` over the
  grid.

## Contract notes and rationale

- Use stable ISO date strings for route/API-facing day identifiers.
- Keep timezone-sensitive formatting explicit and user-readable.
- Avoid coupling calendar components directly to WebSocket state; use
  hooks/props.

## Working notes

- Keep dense calendar layouts responsive for narrow side panels and mobile
  widths.

## Verification commands

- Run `pnpm --filter @assistant/web build` for this subtree.
- Run root `pnpm run build` before closeout.
