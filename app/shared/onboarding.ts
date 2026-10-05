/** First-run setup state. Existing installations are never enrolled retroactively. */
export interface OnboardingState {
  required: boolean;
  /** A new installation finished provider sign-in and can start guided setup. */
  guidedSetup: boolean;
}
