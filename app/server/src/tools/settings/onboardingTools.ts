import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import { finishOnboarding, onboardingState } from "../../onboarding.ts";

/**
 * Ends first-run guided setup on the user's word (`docs/onboarding.md`): the
 * same operation as the setup screen's Finish setup button.
 */
const onboardingFinishTool = defineAgentTool<Record<string, unknown>>({
  name: "onboarding_finish",
  label: "Finish Setup",
  description:
    "End first-run guided setup once the user is done or wants to skip the rest. This conversation then ends and the user continues in a fresh one without setup instructions, so say your closing words first.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute() {
    if (onboardingState() !== "setup")
      throw new Error("Guided setup is not running; there is nothing to end.");
    return jsonResult({ state: await finishOnboarding() });
  },
});

export const onboardingTools = [onboardingFinishTool];
