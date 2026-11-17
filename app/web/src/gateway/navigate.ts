/**
 * Leaves the page for `url`: the start answer's Atlassian authorize URL, which
 * the shared decoder already pinned. The dev server (`gatewayDevApi.ts`,
 * serve only) replaces this module so the dev page never leaves localhost.
 */
export const goTo = (url: string): void => window.location.assign(url);
