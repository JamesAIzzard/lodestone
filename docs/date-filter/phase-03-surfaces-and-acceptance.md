# Phase 3: Surfaces and Acceptance

Status: ready · Depends on: phase 2

## Goal

Expose the window to both clients. `lodestone_search` takes `since` and `until`, the app's search
view gets two date inputs, results show their date in both places, and the guide tells clients
what the date means. Then run the acceptance list from [design.md](design.md#acceptance) against
the installed build after the install sequence in the overview.

## Changes

`src/shared/portable/date-bounds.ts` (new)
- `parseDateBound(value: string, edge: 'from' | 'to'): number`, per the table in
  [design.md](design.md#filter-semantics). Date-only input is local time; `'to'` returns the last
  millisecond of that day. Throws `Error` with the exact message from the design on bad input.
- `parseDateWindow(since?: string, until?: string): { dateFromMs?: number; dateToMs?: number }`
  that calls the above and throws when `since` is after `until`.
- Pure, no imports from Node or Electron, so the renderer can use it.

`src/backend/mcp/tools-search.ts`
- Add to the schema:
  `since: z.string().optional()` described as
  `Only return files dated on or after this (YYYY-MM-DD or ISO 8601). For email this is the received time; for files it is the last modified time. Compute relative windows from lodestone_get_datetime.`
  and `until` described symmetrically as on or before.
- Parse with `parseDateWindow` inside the existing `try`, so a bad value returns
  `errorResponse` with the design's message and never reaches the pipe. Pass `dateFromMs` and
  `dateToMs` to `deps.silo.search`.

`src/backend/mcp/types.ts`
- Add the two numeric fields to the `search` dependency signature.

`src/main/internal-api.ts`
- `handleSearch`: read `dateFromMs` and `dateToMs` from `params` as optional numbers and put
  them on `SearchParams`, next to `filePattern`.

`src/backend/mcp/formatting.ts`
- `formatSearchResults`: when `result.dateMs` is not null, append ` | Date: <local date time>`
  to the silo line, formatted with the same helpers `buildDatetime` uses but without the
  timezone suffix, for example `Silo: 2377507@swansea.ac.uk | Score: 82% (semantic) | Date: 21 December 2025, 07:15`.
- `SEARCH_DESCRIPTION`: add a short paragraph on `since`/`until` and what the date is for mail
  versus files. Keep it to three lines; clients read it every call.

`src/backend/mcp/resources.ts` (`MAIL_SILO_GUIDE` and the startup tool list)
- In the mail paragraph, replace "the frontmatter records the sender, recipients, date, folders"
  with wording that also says each hit shows its received date and that `since`/`until` filter
  on it. Add one sentence to the tools list saying every result carries a date and that
  `lodestone_search` accepts `since` and `until`.

`src/renderer/views/SearchView.tsx`
- Two `<input type="date">` controls in the filter row after the file pattern input, with
  placeholders `since` and `until`, each with the same clear button pattern as the path filter.
  State through `useSessionState` under `search.since` and `search.until`.
- `runSearch` calls `parseDateWindow` and passes the numbers. A parse error cannot happen from a
  date input, but `since` after `until` can; show the message inline where the stopped-silo
  warning is shown and do not run the search.
- Result card: show the date under the file name in the muted style used for the silo name,
  formatted as a local date and time via a new helper in `src/renderer/lib/format.ts`.
- Directory mode is unaffected; hide the date inputs there as the file pattern input is hidden.

`src/shared/electron-api.d.ts`
- No change if `search` already takes `SearchParams`; confirm rather than assume.

`README.md`
- One paragraph on date filtering and a pointer to this folder.

## Tests

`src/shared/portable/date-bounds.test.ts` (new)
- Date-only `from` is local midnight; date-only `to` is 23:59:59.999 local; use a fixed date and
  compare against `new Date(y, m, d)` so the test is timezone-independent.
- Zoned ISO strings give the exact instant for either edge.
- Unzoned ISO date-times are local.
- `2026-13-01`, `yesterday`, an empty string, and `2026-08-01T25:00` each throw with the exact
  message.
- `since` after `until` throws.

`src/backend/mcp/tools-search.test.ts` (new, or extend an existing MCP test if one covers the
search tool)
- A call with `since` and `until` reaches `deps.silo.search` with the parsed numbers.
- A call with a bad `since` returns an error response and does not call `deps.silo.search`.

`src/backend/mcp/formatting.test.ts` (new or extended)
- A result with `dateMs` prints the date on the silo line; one with null does not.

## Acceptance

Follow the install sequence in [00-overview.md](00-overview.md#install-sequence), then work
through every bullet in [design.md](design.md#acceptance) from Claude Code against the installed
build, not the dev build. Record each as command or action, observed result, and pass or fail in
`docs/date-filter/acceptance-<date>.md`. Include the migration script output for both profiles
and the pre- and post-install file counts from `lodestone_status`.

## Done when

- All tests above pass, `npm run typecheck` and `npm run lint` are clean.
- The acceptance file exists with every bullet marked pass, or with a linked issue for any
  failure.
- Both profiles are at version 6 and no silo rebuilt during the install.
