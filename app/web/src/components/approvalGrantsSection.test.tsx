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
import { DialogProvider } from "./common/dialogs.tsx";

/**
 * The inspector's Approvals section for a spawned session: what it inherits
 * from its spawn ancestors shows read-only, naming the session that holds each
 * grant, because that session is the only place it can be revoked. Each own
 * grant shows its scope, which a row or the whole section can change.
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
  granted?: Array<{ key: string; inheritable: boolean }>;
  scoped?: Array<{ keys: string[]; inheritable: boolean }>;
}) {
  act(() =>
    root!.render(
      <DialogProvider>
        <SessionContextSections
          sessionId="child"
          approvalGrants={props.grants ?? []}
          inheritedApprovalGrants={props.inherited ?? []}
          approvalGrantInheritance={props.inheritance}
          sessions={sessions}
          onOpenSession={(id) => props.opened?.push(id)}
          onRevokeApprovalGrant={(_session, key) => props.revoked?.push(key)}
          onGrantApproval={(_session, key, inheritable) =>
            props.granted?.push({ key, inheritable: inheritable === true })
          }
          onSetApprovalGrantScope={(_session, keys, inheritable) =>
            props.scoped?.push({ keys, inheritable })
          }
        />
      </DialogProvider>,
    ),
  );
}

/** Settle the promise a `dialogs.confirm(...)` handler is awaiting. */
async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function clickButton(scope: ParentNode, label: string): void {
  const button = [...scope.querySelectorAll("button")].find((item) =>
    item.textContent?.trim().startsWith(label),
  );
  expect(button, `no “${label}” button`).toBeDefined();
  act(() => button!.click());
}

function dialog(): HTMLElement {
  const open = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(open, "no dialog open").not.toBeNull();
  return open!;
}

const own = (key: string, inheritable: boolean): ApprovalGrant => ({
  key,
  grantedAt: 1,
  sourceApprovalId: "",
  inheritable,
});

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
        inheritable: true,
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
    grants: [
      {
        key: "jira:comment",
        grantedAt: 1,
        sourceApprovalId: "a1",
        inheritable: false,
      },
    ],
    inherited: [
      {
        key: "jira:comment",
        grantedAt: 2,
        sourceApprovalId: "",
        heldBy: "parent",
        inheritable: true,
      },
      {
        key: "jira:edit",
        grantedAt: 3,
        sourceApprovalId: "",
        heldBy: "parent",
        inheritable: true,
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

it("shows each own grant's scope and changes one: passing down confirms, keeping does not", async () => {
  const scoped: Array<{ keys: string[]; inheritable: boolean }> = [];
  render({
    grants: [own("jira:comment", false), own("jira:edit", true)],
    scoped,
  });

  const comment = openRow("Jira: comment on issues");
  expect(comment.textContent).toContain("ScopeThis session only");
  clickButton(comment, "Pass to sessions it starts");
  expect(scoped).toEqual([]);
  expect(dialog().textContent).toContain(
    "Pass “Jira: comment on issues” to the sessions it starts?",
  );
  clickButton(dialog(), "Pass down");
  await settled();
  expect(scoped).toEqual([{ keys: ["jira:comment"], inheritable: true }]);

  const edit = openRow("Jira: edit issues");
  expect(
    edit.querySelector('[aria-label="Also the sessions it starts"]'),
  ).not.toBeNull();
  expect(edit.textContent).toContain(
    "ScopeThis session and the sessions it starts",
  );
  clickButton(edit, "Keep to this session");
  expect(scoped.at(-1)).toEqual({ keys: ["jira:edit"], inheritable: false });
});

it("changes every own grant's scope with one message", async () => {
  const scoped: Array<{ keys: string[]; inheritable: boolean }> = [];
  render({
    grants: [
      own("jira:comment", false),
      own("jira:edit", true),
      own("github:comment", false),
    ],
    inherited: [
      {
        key: "jira:create",
        grantedAt: 1,
        sourceApprovalId: "",
        heldBy: "parent",
        inheritable: true,
      },
    ],
    scoped,
  });

  clickButton(container!, "Pass all to sessions it starts");
  expect(dialog().textContent).toContain(
    "Pass 2 approvals to the sessions it starts?",
  );
  clickButton(dialog(), "Pass down");
  await settled();
  expect(scoped).toEqual([
    { keys: ["jira:comment", "github:comment"], inheritable: true },
  ]);

  clickButton(container!, "Keep all to this session");
  expect(scoped.at(-1)).toEqual({ keys: ["jira:edit"], inheritable: false });
});

it("a cancelled pass-down changes nothing", async () => {
  const scoped: Array<{ keys: string[]; inheritable: boolean }> = [];
  render({ grants: [own("jira:comment", false)], scoped });

  clickButton(container!, "Pass all to sessions it starts");
  clickButton(dialog(), "Cancel");
  await settled();
  expect(scoped).toEqual([]);
});

it.each([
  [false, false],
  [true, true],
])(
  "Allow… grants this session only unless the box is ticked (ticked: %s)",
  async (tick, inheritable) => {
    const granted: Array<{ key: string; inheritable: boolean }> = [];
    render({ granted });
    act(() =>
      container!.querySelector<HTMLElement>("[aria-expanded]")!.click(),
    );

    const row = openRow("Jira: comment on issues");
    clickButton(row, "Allow for this session");
    const box = dialog().querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box.getAttribute("aria-checked")).toBe("false");
    if (tick) act(() => box.click());
    clickButton(dialog(), "Allow");
    await settled();

    expect(granted).toEqual([{ key: "jira:comment", inheritable }]);
  },
);
