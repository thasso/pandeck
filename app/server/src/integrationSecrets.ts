/**
 * Deployment credentials used only by the core server. Capture and delete them
 * during module initialization so later imports and spawned subprocesses do not
 * see these approved names or their discarded aliases.
 */
const CORE_INTEGRATION_SECRET_ENV_VARS = [
  "ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET",
  "ASSISTANT_SLACK_APP_TOKEN",
  "ASSISTANT_SLACK_CLIENT_SECRET",
  "ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET",
] as const;

/** Former aliases: never accepted, but still removed so agents cannot inherit them. */
const DISCARDED_INTEGRATION_SECRET_ENV_VARS = [
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "TEMPO_OAUTH_CLIENT_SECRET",
] as const;

export const SCRUBBED_INTEGRATION_SECRET_ENV_VARS = [
  ...CORE_INTEGRATION_SECRET_ENV_VARS,
  ...DISCARDED_INTEGRATION_SECRET_ENV_VARS,
] as const;

type CoreIntegrationSecretEnvVar =
  (typeof CORE_INTEGRATION_SECRET_ENV_VARS)[number];

function capture(name: CoreIntegrationSecretEnvVar): string {
  const value = process.env[name]?.trim() ?? "";
  delete process.env[name];
  return value;
}

/** Immutable boot-time values captured before the rest of the server starts. */
export const CORE_INTEGRATION_SECRETS = Object.freeze({
  googleOauthClientSecret: capture("ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET"),
  slackAppToken: capture("ASSISTANT_SLACK_APP_TOKEN"),
  slackClientSecret: capture("ASSISTANT_SLACK_CLIENT_SECRET"),
  tempoOauthClientSecret: capture("ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET"),
});

for (const name of DISCARDED_INTEGRATION_SECRET_ENV_VARS)
  delete process.env[name];
