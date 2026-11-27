import type { MouseEvent } from "react";
import { isPlainPrimaryClick } from "../../lib/portForwardLinks.ts";

/**
 * Follow an in-app link like the router does, leaving modified clicks (new
 * tab, new window) to the browser. Shared by the Schedules surfaces, the
 * inspector section and the header chip without loading the lazy pages.
 */
export function openInApp(
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
  onOpen: (path: string) => void,
) {
  if (!isPlainPrimaryClick(event)) return;
  event.preventDefault();
  onOpen(path);
}
