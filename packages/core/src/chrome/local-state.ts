/**
 * Whether "Warn before quitting" is on, from Local State's `browser.confirm_to_quit` (docs/IMPLEMENTATION.md §5). Chrome
 * reads anything but an explicit `false` as on, a missing value included [source `confirm_quit.cc:17-19`].
 */
export function confirmToQuitOn(value: unknown): boolean {
  return value !== false;
}
