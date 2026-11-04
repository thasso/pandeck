/**
 * Claude usage bodies shared by the gateway usage tests (G4b): the shape the
 * user-run live smoke measured (MU-1363-02), and 200 bodies that are drift.
 * Values are synthetic.
 */

/** AC4(b): the shape MU-1363-02 measured, with values filled in. */
export const MEASURED_USAGE = {
  five_hour: null,
  seven_day: {
    utilization: 1,
    resets_at: "2026-11-11T01:00:00.154760+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  nimbus_quill: null,
  promo_credits: null,
  pace: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    decimal_places: null,
    disabled_reason: null,
    user_disabled: false,
    spend_limit_reached: false,
    credits_ever_enabled: false,
    daily: null,
    weekly: null,
  },
  limits: [
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 1,
      severity: "normal",
      resets_at: "2026-11-11T01:00:00.154760+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      severity: "normal",
      resets_at: "2026-11-11T01:00:00+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: null,
    percent: 0,
    severity: "normal",
    enabled: false,
    disabled_reason: null,
    cap: null,
    balance: null,
    auto_reload: null,
    disclaimer: "fixture",
    can_purchase_credits: false,
    can_toggle: false,
  },
  member_dashboard_available: false,
  seven_day_breakdown: {
    as_of: "2026-11-04T15:00:00+00:00",
    window_started_at: "2026-11-04T01:00:00+00:00",
    rows: [
      { key: "code", display_name: "Claude Code", percent: 100 },
      { key: "chats", display_name: "Chats", percent: 0 },
    ],
  },
  weekly_scoped_shares: [
    {
      limit_index: 1,
      used_percent_of_weekly: 0,
      allowance_percent_of_weekly: 100,
    },
  ],
};

/** AC5: 200 bodies the mapper does not recognise as usage. */
export const DRIFTED_USAGE: [string, string][] = [
  ["non-JSON", "<html>not json</html>"],
  ["an array", "[]"],
  ["an empty object", "{}"],
  ["limits only", '{"limits":[]}'],
  ["a string window", '{"five_hour":"x"}'],
  ["a string utilization", '{"five_hour":{"utilization":"42"}}'],
  ["two null windows", '{"five_hour":null,"seven_day":null}'],
  ["a numeric reset", '{"seven_day":{"utilization":42,"resets_at":7}}'],
];
