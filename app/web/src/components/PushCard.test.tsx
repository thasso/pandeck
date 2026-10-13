import type { PushDisplay } from "@assistant/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PushCard } from "./PushCard.tsx";

const push: PushDisplay = {
  status: "pushed",
  remote: "origin",
  branch: "feature",
  forced: false,
  setUpstream: false,
};

function links(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>.*?<\/a>/gs)].map((match) => match[0]);
}

describe("PushCard", () => {
  it("links the pushed branch and its pull request on the provider", () => {
    const html = renderToStaticMarkup(
      <PushCard
        push={{
          ...push,
          hosted: {
            provider: "github",
            branchUrl: "https://github.com/acme/repo/tree/feature",
            pullRequest: {
              number: 42,
              url: "https://github.com/acme/repo/pull/42",
              title: "Ship it",
              state: "merged",
            },
          },
        }}
      />,
    );
    const [branch, pullRequest] = links(html);
    expect(branch).toContain(
      'href="https://github.com/acme/repo/tree/feature"',
    );
    expect(branch).toContain("origin/feature");
    expect(pullRequest).toContain(
      'href="https://github.com/acme/repo/pull/42"',
    );
    expect(pullRequest).toContain('target="_blank"');
    expect(pullRequest).toContain(">#42<");
    expect(pullRequest).toContain("Ship it");
    expect(pullRequest).toContain("merged");
  });

  it("states the target as plain text without a hosting provider", () => {
    const html = renderToStaticMarkup(<PushCard push={push} />);
    expect(links(html)).toEqual([]);
    expect(html).toContain("origin/feature");
  });
});
