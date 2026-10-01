import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { knowledgeBaseBehaviorGuidance } from "./knowledgeBasePrompt.ts";
import {
  kbAddAssetTool,
  kbEditEntryTool,
  kbReadAssetTool,
  kbWriteEntryTool,
} from "./tools/knowledge/knowledgeBaseTools.ts";
import { projectRegistryReadTool } from "./tools/core/projectRegistryTools.ts";
import { eagerToolNamesFor } from "./tools/catalog.ts";

/**
 * KB 284/286: Task 284 moves KB guidance from eager prompts to deferred tool
 * descriptions. The eager section shrinks to a minimal pointer; full operational
 * guidance lives in the kb_* tool descriptions and parameters. Tests verify:
 * - eager guidance stays compact (<= 600 chars) and points to tools,
 * - deferred tool descriptions teach critical KB behaviors (when/how to read/write/ask,
 *   scoping, pa:// links, stable ids, frontmatter/validation, assets, comments, provenance),
 * - the split is clean: shared rules live only in tools' descriptions, not duplicated.
 */
describe("knowledge base agent guidance", () => {
  const guidance = knowledgeBaseBehaviorGuidance();

  test("eager pointer stays compact and references kb_* tools", () => {
    assert.ok(
      guidance.length <= 600,
      `eager guidance too long (${guidance.length} chars); move detail to tool descriptions`,
    );
    for (const tool of [
      "kb_search",
      "kb_get_entry",
      "kb_write_entry",
      "kb_edit_entry",
    ]) {
      assert.match(
        guidance,
        new RegExp(tool),
        `eager pointer should mention ${tool}`,
      );
    }
    assert.doesNotMatch(
      guidance,
      /knowledge_[a-z]/,
      "obsolete knowledge_* skill tools must not be taught",
    );
    assert.match(
      guidance,
      /never edit DATA_DIR\/knowledge directly/i,
      "must forbid raw filesystem writes",
    );
  });

  test("eager pointer makes the KB discoverable now that no kb_* tool is eager", () => {
    // Task-286 defers `knowledge-core`. The pointer is the ONLY eager surface
    // left that can send a session to the KB, so it must say the tools are
    // loaded on demand rather than assume they are in context.
    assert.match(
      guidance,
      /tool search/i,
      "the pointer must tell the session to load the kb_* tools first",
    );
    for (const persona of ["assistant", "developer"] as const) {
      const eager = eagerToolNamesFor(persona);
      for (const name of ["kb_search", "kb_get_entry"])
        assert.ok(
          !eager.has(name),
          `${name} is eager again for ${persona} — the pointer's discovery wording is now misleading`,
        );
    }
  });

  test("eager pointer teaches when to search (before answering durable questions)", () => {
    const surface = `${guidance}`;
    assert.match(
      surface,
      /before answering durable questions/i,
      "the trigger for KB search must be in eager text so Task-286 deference doesn't hide it",
    );
  });

  test("kb_write_entry teaches when/how to write, scoping, provenance, and secrets", () => {
    const surface = `${kbWriteEntryTool.description}`;
    assert.match(surface, /durable long-form knowledge/i);
    assert.match(surface, /separate entries/i);
    assert.match(surface, /cross-contamination/i);
    assert.match(surface, /never invent/i);
    assert.match(surface, /pa:\/\//);
    assert.match(surface, /never store secrets/i);
    assert.match(surface, /record provenance/i);
    assert.match(surface, /mark uncertain facts/i);
    assert.match(surface, /Memory.*not the KB/i);
  });

  test("kb_edit_entry teaches frontmatter validation and secrets", () => {
    const surface = `${kbEditEntryTool.description}`;
    assert.match(surface, /kb\.schema/);
    assert.match(surface, /kb\.type/);
    assert.match(surface, /kb\.status/);
    assert.match(surface, /error names the exact field/i);
    assert.match(surface, /never store secrets/i);
  });

  test("kb_add_asset teaches to never store secrets", () => {
    const surface = `${kbAddAssetTool.description}`;
    assert.match(surface, /never store secrets/i);
  });

  test("project_registry_read teaches when to use it and anti-confabulation", () => {
    const surface = `${projectRegistryReadTool.description}`;
    assert.match(surface, /before assuming/i);
    assert.match(surface, /matchedBy.*confidence.*warnings/i);
    assert.match(
      surface,
      /no registry match.*say that.*instead of inventing/i,
      "anti-confabulation rule must be in the read tool description",
    );
  });

  test("eager KB pointer does not restate what deferred tool descriptions teach", () => {
    // The eager section is a discovery pointer. It should not restate the operational
    // rules (when to write, scoping, provenance, secrets) that now live on the tools.
    // This prevents duplication and keeps the eager section compact.
    assert.doesNotMatch(
      guidance,
      /durable long-form/i,
      "eager text should not repeat write-tool-specific rules",
    );
    assert.doesNotMatch(
      guidance,
      /separate entries/i,
      "scoping rules belong on tools, not eager text",
    );
  });

  test("the one tool-local KB rule lives on its tool, not in eager guidance", () => {
    // kb_read_asset reads COMMITTED entry assets; kb_read_extract reads
    // GENERATED extracts. Confusing them is a real call error, and the eager
    // section deliberately does not teach it — so the tool must.
    assert.doesNotMatch(
      guidance,
      /kb_read_asset/,
      "the shared section should not carry a single tool's local rule",
    );
    assert.match(
      kbReadAssetTool.description,
      /kb_read_extract reads only GENERATED extracts/,
      "kb_read_asset must state what separates it from kb_read_extract",
    );
  });
});
