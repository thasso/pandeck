import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ToolCallBlock } from "./ToolCallBlock.tsx";

/**
 * The body is viewport-gated (`useNearViewport`), so an expanded block off screen
 * renders a placeholder instead of its (expensive) body. These render without
 * effects — the same state a not-yet-observed block is in on the client — so they
 * pin the gate itself: header always present, body withheld until near.
 */
test("an expanded block renders its header immediately", () => {
  const html = renderToStaticMarkup(
    <ToolCallBlock
      name="read"
      status="success"
      defaultOpen
      summary="src/App.tsx"
    >
      <div>BODY</div>
    </ToolCallBlock>,
  );
  expect(html).toContain("read");
  expect(html).toContain("src/App.tsx");
  expect(html).toContain('aria-expanded="true"');
});

test("the body waits for the viewport gate instead of building eagerly", () => {
  const html = renderToStaticMarkup(
    <ToolCallBlock name="read" status="success" defaultOpen>
      <div>BODY</div>
    </ToolCallBlock>,
  );
  expect(html).not.toContain("BODY");
  // The flag rides the BODY element (the one the header's `aria-controls`
  // names), which is still mounted when the children land, so it clears in
  // place rather than disappearing with a placeholder (R6).
  expect(html).toMatch(/<div[^>]+id="[^"]+"[^>]+aria-busy="true"/);
});

/**
 * The running header used to hand-build its ring here (Task-390 folded it into
 * `Spinner`'s `ring` variant): still one decorative element on this hot path,
 * still stilled under `prefers-reduced-motion`, and the status stays in text.
 */
test("a running block spins the shared ring and names the status in text", () => {
  const html = renderToStaticMarkup(
    <ToolCallBlock name="read" status="running">
      <div>BODY</div>
    </ToolCallBlock>,
  );
  expect(html).toContain("motion-safe:animate-spin");
  expect(html).toContain("border-t-primary");
  // The chevron is the header's ONLY icon: the ring is a bordered box, not a
  // second lucide module pulled onto the transcript's hottest path.
  expect(html.split("<svg").length - 1).toBe(1);
  expect(html).toContain("Running tool call:");
});

test("a collapsed block renders no body region at all", () => {
  const html = renderToStaticMarkup(
    <ToolCallBlock name="read" status="success">
      <div>BODY</div>
    </ToolCallBlock>,
  );
  expect(html).not.toContain("BODY");
  expect(html).not.toContain('aria-busy="true"');
  expect(html).toContain('aria-expanded="false"');
});
