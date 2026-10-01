import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { sessionArtifactDeliveryHeaders } from "./sessionArtifactHttp.ts";

describe("session artifact delivery headers", () => {
  test("allows raster images inline with MIME sniffing disabled", () => {
    assert.deepEqual(
      sessionArtifactDeliveryHeaders(
        "/data/session-artifacts/s/image.png",
        new URL("http://localhost/api/session-artifacts/s/image.png"),
      ),
      { "x-content-type-options": "nosniff" },
    );
  });

  test("forces active and non-image content to download without a query flag", () => {
    const headers = sessionArtifactDeliveryHeaders(
      "/data/session-artifacts/s/report.html",
      new URL(
        "http://localhost/api/session-artifacts/s/report.html?name=Drive%20report.html",
      ),
    );
    assert.equal(headers["x-content-type-options"], "nosniff");
    assert.equal(
      headers["content-security-policy"],
      "sandbox; default-src 'none'",
    );
    assert.match(
      headers["content-disposition"] ?? "",
      /^attachment; filename="Drive report\.html";/,
    );
  });

  test("honors an explicit download for raster images and sanitizes the name", () => {
    const headers = sessionArtifactDeliveryHeaders(
      "/data/session-artifacts/s/image.png",
      new URL(
        "http://localhost/api/session-artifacts/s/image.png?download=1&name=bad%22%0D%0Aname.png",
      ),
    );
    assert.equal(
      headers["content-security-policy"],
      "sandbox; default-src 'none'",
    );
    assert.match(
      headers["content-disposition"] ?? "",
      /^attachment; filename="bad___name\.png";/,
    );
    assert.doesNotMatch(headers["content-disposition"] ?? "", /\r|\n/);
  });
});
