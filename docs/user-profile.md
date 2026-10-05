# User profile

The app works for one user. `AppSettings.profile` says who that is. Nothing in
product code may assume a particular person or zone.

## Settings

Stored in `DATA_DIR/settings/app.json` under `profile`, and edited in **Settings
→ Profile** (General group):

- `displayName`: trimmed. `""` leaves the user unnamed.
- `timeZone`: an IANA zone, or `""` to follow the server host. An invalid stored
  value is normalized to `""`, so it also follows the host.

The projection the client receives also carries the read-only
`effectiveTimeZone`. It resolves to the stored zone when valid, else the host
zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`), else `"UTC"`. A save
ignores it.

## One timezone

`effectiveTimeZone` is the only zone that user-local days and times resolve in.
It covers:

- calendar day buckets and range bounds in the web client;
- "today" and "tomorrow" for Task due and plan filters;
- memory temporal rules (recurring weekdays, observation snapshots);
- the local times and `date` parameters of the Google, GitHub and Slack tools;
- the default zone of `current_time`.

`memory.timezone` no longer exists, and a stale stored key is ignored. A static
`slack.timezone` (config file or `SLACK_TIMEZONE`) still pins the Slack tools to
a deployment zone. It is unset by default, so they follow the profile too.

The server reads the zone at use time through `userTimeZone()` in
`app/server/src/userProfile.ts`, so a change applies without a restart. Never
capture it in a module-level constant or hardcode a zone. The parsed profile is
cached per version of the settings file: each call checks the file's inode, size
and mtime, and `updateSettings` also drops the cache, so hot formatters cost no
file read while edits still apply at once. The web client reads the zone from
`settings.profile.effectiveTimeZone`, which `App` provides to components through
`hooks/useUserTimeZone.ts`. Every zone-dependent helper in
`components/calendar/calendarDates.ts` takes the zone explicitly. Until the
server answers, the web client uses the browser's zone.

## Local days

Every user-local day window and wall-clock time, on the server and in the web
client, comes from `app/shared/zonedTime.ts`: `localDayBoundsMs` (a day is
[first instant whose local date is D, first instant of D+1)), `localWallTimeMs`
`localDateOf`, and `addLocalDays` (the same wall time N calendar days away,
which memory uses for relative validity windows). `current_time` reports each
day bound with the offset in force at that bound. Never derive a local midnight
from one offset: zones that shift at midnight (America/Havana skips 00:00,
Pacific/Auckland's midnight keeps the old offset) break that shortcut. An
ambiguous wall time resolves to its first occurrence and a skipped one to the
end of the gap.

## Name

- A new Task comment the user writes stores `displayName`, or `"You"` when
  unset. Persisted comments keep the name they were stored with.
- Worktree comments store only that the user wrote them. The projection names
  them with the current display name, or `"You"`.
