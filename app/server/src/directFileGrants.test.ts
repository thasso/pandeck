import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  FILE_GRANT_SANDBOX_CSP,
  fileGrantDeliveryHeaders,
  mintDocumentGrant,
  resetFileGrantsForTest,
  resolveFileGrantTarget,
} from "./directFileGrants.ts";

/**
 * A grant binds reach, lifetime, and delivery. These tests cover those limits
 * because everything else in served-files relies on them holding
 * (`docs/served-files.md`).
 */

let root: string;
let outside: string;

beforeEach(() => {
  resetFileGrantsForTest();
  // Canonical from the start: macOS `/tmp` is itself a symlink, and a grant
  // resolves paths for real.
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pa-grants-")));
  root = join(base, "report");
  outside = join(base, "secrets");
  mkdirSync(root);
  mkdirSync(join(root, "assets"));
  mkdirSync(outside);
  writeFileSync(join(root, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(root, "other.html"), "<h1>other</h1>");
  writeFileSync(
    join(root, "assets", "index.html"),
    "<script src=app.js></script>",
  );
  writeFileSync(join(root, "assets", "app.js"), "console.log(1);");
  writeFileSync(join(outside, "token"), "SECRET");
});

afterEach(() => {
  vi.useRealTimers();
  resetFileGrantsForTest();
});

const urlFor = (id: string, rest: string) => `/api/file-grants/${id}/${rest}`;

describe("what a grant reaches", () => {
  test("serves the document and its nested subresources", async () => {
    const grant = await mintDocumentGrant(join(root, "index.html"));
    assert.equal(grant.url, `/api/file-grants/${grant.grantId}/index.html`);
    assert.equal(
      (await resolveFileGrantTarget(urlFor(grant.grantId, "index.html")))?.path,
      join(root, "index.html"),
    );
    assert.equal(
      (await resolveFileGrantTarget(urlFor(grant.grantId, "assets/app.js")))
        ?.path,
      join(root, "assets", "app.js"),
    );
  });

  test("a single-resource grant refuses siblings", async () => {
    const grant = await mintDocumentGrant(
      join(root, "index.html"),
      "file",
      "attachment",
    );
    assert.equal(
      (await resolveFileGrantTarget(urlFor(grant.grantId, "index.html")))?.path,
      join(root, "index.html"),
    );
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "assets/app.js")),
      undefined,
    );
    assert.equal(
      (await resolveFileGrantTarget(grant.url))?.delivery,
      "attachment",
    );
  });

  test("refuses attachment delivery over a directory grant", async () => {
    await assert.rejects(
      () =>
        mintDocumentGrant(join(root, "index.html"), "directory", "attachment"),
      /one file/,
    );
  });

  test("refuses every spelling that climbs out lexically", async () => {
    const grant = await mintDocumentGrant(join(root, "index.html"));
    for (const escape of [
      "../secrets/token",
      "..%2Fsecrets%2Ftoken",
      "assets/../../secrets/token",
      "%2E%2E%2Fsecrets%2Ftoken",
    ]) {
      assert.equal(
        await resolveFileGrantTarget(urlFor(grant.grantId, escape)),
        undefined,
        escape,
      );
    }
  });

  test("refuses a SYMLINK inside the directory that points out of it", async () => {
    // The escape `..` cannot express: a contained name whose canonical path is
    // anywhere on the host. Without canonical containment this one-directory
    // capability would reach the whole filesystem.
    symlinkSync(join(outside, "token"), join(root, "inside.txt"));
    symlinkSync(outside, join(root, "assets", "away"));
    const grant = await mintDocumentGrant(join(root, "index.html"));
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "inside.txt")),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "away/token")),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "assets/away/token")),
      undefined,
    );
  });

  test("refuses a directory, a missing file and a sibling prefix match", async () => {
    mkdirSync(join(root, "..", "report-secrets"));
    writeFileSync(join(root, "..", "report-secrets", "x"), "x");
    const grant = await mintDocumentGrant(join(root, "index.html"));
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "assets")),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "gone.html")),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget(
        urlFor(grant.grantId, "../report-secrets/x"),
      ),
      undefined,
    );
  });

  test("rejects an unknown grant, a bare grant and a NUL byte", async () => {
    const grant = await mintDocumentGrant(join(root, "index.html"));
    assert.equal(
      await resolveFileGrantTarget("/api/file-grants/nope/index.html"),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget(`/api/file-grants/${grant.grantId}`),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "a%00b.html")),
      undefined,
    );
    assert.equal(
      await resolveFileGrantTarget("/api/files/tmp/example/x.html"),
      undefined,
    );
  });
});

describe("how long a grant lives", () => {
  test("a read never extends it, so a leaked id still dies", async () => {
    vi.useFakeTimers();
    const grant = await mintDocumentGrant(join(root, "index.html"));
    const expiresAt = grant.expiresAt;

    // Keep reading it right up to the edge: an unauthenticated reader must not
    // be able to renew the capability it was handed.
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(11 * 60 * 1000);
      assert.ok(
        await resolveFileGrantTarget(urlFor(grant.grantId, "index.html")),
      );
      assert.equal(grant.expiresAt, expiresAt);
    }
    // Exactly to the deadline: 55 minutes of reads above, then the last five.
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    assert.ok(
      await resolveFileGrantTarget(urlFor(grant.grantId, "index.html")),
      "alive up to the last millisecond",
    );
    vi.advanceTimersByTime(1);
    assert.equal(
      await resolveFileGrantTarget(urlFor(grant.grantId, "index.html")),
      undefined,
      "dead exactly at its fixed deadline",
    );
  });

  test("re-minting reuses a live grant but replaces an expiring one", async () => {
    vi.useFakeTimers();
    const first = await mintDocumentGrant(join(root, "index.html"));
    // Same directory, still plenty of life: the page loading subresources under
    // the first id must not have it swapped out from under it.
    assert.equal(
      (await mintDocumentGrant(join(root, "other.html"))).grantId,
      first.grantId,
    );

    vi.advanceTimersByTime(58 * 60 * 1000);
    const renewed = await mintDocumentGrant(join(root, "index.html"));
    assert.notEqual(renewed.grantId, first.grantId);
    assert.ok(renewed.expiresAt > first.expiresAt);
  });

  test("delivery mode is part of grant reuse identity", async () => {
    const inline = await mintDocumentGrant(
      join(root, "index.html"),
      "file",
      "inline",
    );
    const attachment = await mintDocumentGrant(
      join(root, "index.html"),
      "file",
      "attachment",
    );
    assert.notEqual(attachment.grantId, inline.grantId);
    assert.equal(
      (await mintDocumentGrant(join(root, "index.html"), "file", "attachment"))
        .grantId,
      attachment.grantId,
    );
  });

  test("a different directory is a different grant", async () => {
    const first = await mintDocumentGrant(join(root, "index.html"));
    const other = await mintDocumentGrant(join(root, "assets", "index.html"));
    assert.notEqual(other.grantId, first.grantId);
  });

  test("fresh renewal bypasses reuse without invalidating the live grant", async () => {
    const first = await mintDocumentGrant(join(root, "index.html"));
    const renewed = await mintDocumentGrant(
      join(root, "index.html"),
      "directory",
      "inline",
      {
        root: "/",
        sourceKey: "host",
        fresh: true,
      },
    );
    assert.notEqual(renewed.grantId, first.grantId);
    assert.ok(await resolveFileGrantTarget(first.url));
    assert.ok(await resolveFileGrantTarget(renewed.url));
  });

  test("canonicalizes the directory, so one symlinked spelling is one grant", async () => {
    symlinkSync(root, join(root, "..", "report-link"));
    const direct = await mintDocumentGrant(join(root, "index.html"));
    const viaLink = await mintDocumentGrant(
      join(root, "..", "report-link", "index.html"),
    );
    assert.equal(viaLink.grantId, direct.grantId);
    assert.equal(viaLink.documentPath, join(root, "index.html"));
  });

  test("names the CANONICAL document in the URL, not a symlink alias", async () => {
    // Minting through `alias.html` scopes the grant to the canonical directory,
    // so a URL carrying the alias name resolves to a file that is not there.
    const links = join(root, "..", "links");
    mkdirSync(links);
    symlinkSync(join(root, "index.html"), join(links, "alias.html"));
    const minted = await mintDocumentGrant(join(links, "alias.html"));
    assert.equal(minted.documentPath, join(root, "index.html"));
    assert.equal(minted.url, `/api/file-grants/${minted.grantId}/index.html`);
    assert.equal(
      (await resolveFileGrantTarget(minted.url))?.path,
      join(root, "index.html"),
    );
  });

  test("rejects directory authority for a non-HTML canonical target", async () => {
    writeFileSync(join(root, "notes.txt"), "notes");
    symlinkSync(join(root, "notes.txt"), join(root, "alias.html"));
    symlinkSync(join(root, "assets"), join(root, "folder.html"));
    await assert.rejects(
      () => mintDocumentGrant(join(root, "alias.html")),
      /canonical HTML/,
    );
    await assert.rejects(() => mintDocumentGrant(join(root, "folder.html")));
    // Exact-file authority is still safe regardless of extension spelling.
    await mintDocumentGrant(join(root, "alias.html"), "file", "inline");
  });

  test("refuses to mint over anything but an existing file", async () => {
    await assert.rejects(() => mintDocumentGrant("/nope/nowhere/x.html"));
    // The directory exists here; the document does not. A grant over it would
    // hand the client a URL that 404s inside the frame.
    await assert.rejects(() => mintDocumentGrant(join(root, "missing.html")));
    await assert.rejects(() => mintDocumentGrant(root));
  });
});

describe("grant delivery headers", () => {
  test("sandboxes every response and types subresources for real", () => {
    const html = fileGrantDeliveryHeaders("/x/index.html");
    assert.equal(html["content-type"], "text/html; charset=utf-8");
    assert.equal(html["content-disposition"], undefined);
    assert.equal(html["content-security-policy"], FILE_GRANT_SANDBOX_CSP);
    assert.doesNotMatch(FILE_GRANT_SANDBOX_CSP, /allow-same-origin/);

    const source = fileGrantDeliveryHeaders("/x/chart.js");
    assert.equal(source["content-type"], "text/plain; charset=utf-8");

    const script = fileGrantDeliveryHeaders(
      "/x/chart.js",
      "inline",
      "chart.js",
      "directory",
    );
    assert.equal(script["content-type"], "text/javascript; charset=utf-8");
    assert.equal(script["content-security-policy"], FILE_GRANT_SANDBOX_CSP);
  });

  test("omits sandbox CSP only for passive inline file-scoped PDF", () => {
    const pdf = fileGrantDeliveryHeaders(
      "/x/report.pdf",
      "inline",
      "report.pdf",
      "file",
    );
    assert.equal(pdf["content-type"], "application/pdf");
    assert.equal(pdf["content-security-policy"], undefined);
    assert.equal(pdf["x-content-type-options"], "nosniff");

    assert.equal(
      fileGrantDeliveryHeaders("/x/active.svg", "inline", "active.svg", "file")[
        "content-security-policy"
      ],
      FILE_GRANT_SANDBOX_CSP,
    );
  });

  test("binds attachment delivery and sanitizes its fallback filename", () => {
    const headers = fileGrantDeliveryHeaders(
      "/x/report.txt",
      "attachment",
      'report"\r\n名.txt',
    );
    assert.equal(
      headers["content-disposition"],
      "attachment; filename=\"report____.txt\"; filename*=UTF-8''report%22%0D%0A%E5%90%8D.txt",
    );
    assert.doesNotMatch(headers["content-disposition"] ?? "", /[\r\n]/);
  });
});
