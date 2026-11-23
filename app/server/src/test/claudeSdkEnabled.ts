/**
 * Turn the Claude integration on or off for a suite. Its default is off, and
 * the bound model resolver refuses every Claude query open, model change and
 * one-shot while it is off (`harnesses/claudeModelResolution.ts`). Imported
 * lazily, so a suite may call these after it sets `DATA_DIR`; written through
 * the settings service like every settings write (`architecture.test.ts`).
 */
async function setClaudeSdkEnabled(enabled: boolean): Promise<void> {
  const { getSettings } = await import("../settings.ts");
  if (getSettings().claudeSdk.enabled === enabled) return;
  const { saveSettings } = await import("../settingsService.ts");
  await saveSettings({ claudeSdk: { ...getSettings().claudeSdk, enabled } });
}

/** For a suite that drives Claude runs. */
export function enableClaudeSdkForTests(): Promise<void> {
  return setClaudeSdkEnabled(true);
}

/** For a case proving that nothing runs while the integration is off. */
export function disableClaudeSdkForTests(): Promise<void> {
  return setClaudeSdkEnabled(false);
}
