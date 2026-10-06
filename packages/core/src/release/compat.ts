/**
 * What this version of Desk reads (docs/IMPLEMENTATION.md §23.4), recorded in every build's `version.json`: the wire
 * protocol range (§7.2) and each state file's `version` (§4.2). `desk use` refuses a version whose `state` is older
 * than a file on disk. A slice that changes a state file's shape bumps its number here (D48), except `installed`,
 * which only ever gains optional keys.
 */
export const DESK_COMPAT = {
  protocol: [1, 1],
  state: { config: 1, layout: 1, panes: 1, installed: 1 },
} as const;

export type DeskCompat = typeof DESK_COMPAT;
