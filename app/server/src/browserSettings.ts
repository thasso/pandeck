import type { BrowserToolSettings } from "@assistant/shared";
import { getSettings } from "./settings.ts";

/** Browser tool-group preferences (headed mode, the raw-MCP escape-hatch gate). */
export function getBrowserToolSettings(): BrowserToolSettings {
  return getSettings().browserTools;
}
