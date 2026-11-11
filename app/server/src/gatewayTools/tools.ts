/** The edge's tools (Task-1397): adding one is its module plus one line. */
import type { ToolDescriptor } from "./descriptor.ts";
import { jiraGetIssue } from "./jiraGetIssue.ts";

export const EDGE_TOOLS: readonly ToolDescriptor[] = [jiraGetIssue];
