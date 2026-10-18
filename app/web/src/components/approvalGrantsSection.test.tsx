// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ApprovalGrant,
  ApprovalGrantInheritance,
  InheritedApprovalGrant,
} from "@assistant/shared";
import { SessionContextSections } from "./SessionContextSections.tsx";

/**
 * The inspector's Approvals section for a spawned session: what it inherits
 * from its spawn ancestors shows read-only, naming the session that holds each
 * grant, because that session is the only place it can be revoked.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

const sessions = [
  { id: "parent", title: "Coordinator" },
  { id: "grandparent", title: "Planner" },
];

function render(props: {
  grants?: ApprovalGrant[];
  inherited?: InheritedApprovalGrant[];
  inheritance?: ApprovalGrantInheritance;
  revoked?: string[];
  opened?: string[];
}) {
  act(() =>
    root!.render(
      <SessionContextSections
        sessionId="child"
        approvalGrants={props.grants ?? []}
        inheritedApprovalGrants={props.inherited ?? []}
        approvalGrantInheritance={props.inheritance}
        sessions={sessions}
        onOpenSession={(id) => props.opened?.push(id)}
        onRevokeApprovalGrant={(_session, key) => props.revoked?.push(key)}
        onGrantApproval={() => {}}
      />,
    ),
  );
}

/** Unfold the row labelled `label` and return it. */
function openRow(label: string): HTMLElement {
  const row = [...container!.querySelectorAll("li")].find((item) =>
    item.textContent?.includes(label),
  );
  expect(row, `no row labelled ${label}`).toBeDefined();
  const toggle = row!.querySelector<HTMLButtonElement>("[aria-expanded]")!;
  act(() => toggle.click());
  return row!;
}

const buttonLabels = (element: HTMLElement) =>
  [...element.querySelectorAll("button")].map((button) =>
    (button.textContent ?? "").trim(),
  );

it("lists an inherited grant as allowed, naming its holder, with nothing to revoke or allow", () => {
  const opened: string[] = [];
  render({
    inherited: [
      {
        key: "jira:comment",
        grantedAt: 1,
        sourceApprovalId: "",
        heldBy: "grandparent",
      },
    ],
    inheritance: { parentSessionId: "parent", inherits: true },
    opened,
  });

  expect(container!.textContent).toContain("1 allowed");
  const row = openRow("Jira: comment on issues");
  expect(row.querySelector('[aria-label="Allowed"]')).not.toBeNull();
  expect(row.textContent).toContain("Inherited from Planner");
  expect(buttonLabels(row).some((label) => label.startsWith("Revoke"))).toBe(
    false,
  );
  expect(buttonLabels(row).some((label) => label.startsWith("Allow"))).toBe(
    false,
  );

  const holder = row.querySelector<HTMLAnchorElement>(
    'a[href="/sessions/grandparent"]',
  );
  expect(holder?.textContent).toBe("Planner");
  act(() => holder!.click());
  expect(opened).toEqual(["grandparent"]);
});

it("keeps Revoke on an own grant an ancestor also holds, and says it stays covered", () => {
  const revoked: string[] = [];
  render({
    grants: [{ key: "jira:comment", grantedAt: 1, sourceApprovalId: "a1" }],
    inherited: [
      {
        key: "jira:comment",
        grantedAt: 2,
        sourceApprovalId: "",
        heldBy: "parent",
      },
      {
        key: "jira:edit",
        grantedAt: 3,
        sourceApprovalId: "",
        heldBy: "parent",
      },
    ],
    inheritance: { parentSessionId: "parent", inherits: true },
    revoked,
  });

  // The union: two operations allowed, one of them twice over.
  expect(container!.textContent).toContain("2 allowed");
  const row = openRow("Jira: comment on issues");
  expect(row.textContent).toContain(
    "Still covered by Coordinator’s grant until revoked there",
  );
  const revoke = [...row.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Revoke"),
  );
  act(() => revoke!.click());
  expect(revoked).toEqual(["jira:comment"]);
});

it("says when the session does not inherit from the session that spawned it", () => {
  render({ inheritance: { parentSessionId: "parent", inherits: false } });
  // Nothing is allowed, so the section starts folded.
  expect(container!.textContent).toContain("All ask first");
  const section = container!.querySelector<HTMLElement>("[aria-expanded]")!;
  act(() => section.click());

  expect(container!.textContent).toContain(
    "Doesn’t inherit approvals from the session that spawned it, Coordinator.",
  );
});

it("says nothing about inheritance for a session nothing spawned", () => {
  render({});

  expect(container!.textContent).not.toContain("inherit");
});
