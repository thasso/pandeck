/**
 * Leaves the page for `url`: a start answer's authorize URL, Atlassian's or
 * Slack's, which the shared decoder already pinned to that provider's
 * endpoint. The dev server (`gatewayDevApi.ts`, serve only) replaces this
 * module so the dev page never leaves localhost.
 */
export const goTo = (url: string): void => window.location.assign(url);
