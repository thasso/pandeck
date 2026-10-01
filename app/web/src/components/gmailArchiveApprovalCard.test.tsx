// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { ApprovalCard as ApprovalCardData } from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

const items = Array.from({ length: 60 }, (_, index) => ({
  messageId: `message-${index}`,
  threadId: `thread-${index}`,
  sender: `Sender ${index} <sender-${index}@example.com>`,
  subject: `Subject ${index} with enough detail to identify the email`,
  gmailUrl: `https://mail.google.com/mail/u/0/#all/thread-${index}`,
}));

const card: ApprovalCardData = {
  renderKind: "approval",
  id: "appr-gmail",
  sessionId: "personal-assistant-session",
  kind: "gmailArchive",
  status: "pending",
  title: "Archive 60 emails",
  summary: "60 emails in 60 threads",
  createdAt: Date.now(),
  body: { kind: "gmailArchive", items },
};

test("the bounded Gmail archive card lists every sender and subject", () => {
  const html = renderToStaticMarkup(<ApprovalCard approval={card} />);
  const container = document.createElement("div");
  container.innerHTML = html;
  const text = container.textContent ?? "";

  for (const item of items) {
    expect(text).toContain(item.sender);
    expect(text).toContain(item.subject);
  }
  expect(html).toContain("max-h-80");
  expect(html).toContain("overflow-y-auto");
  const region = container.querySelector('[role="region"]');
  expect(region?.getAttribute("aria-label")).toBe("60 emails to archive");
  expect(region?.getAttribute("tabindex")).toBe("0");
  expect(html).toContain("Approve");
  expect(html).toContain("Reject");
});
