import assert from "node:assert/strict";
import { test } from "vitest";
import { knowledgeBaseBehaviorGuidance } from "./knowledgeBasePrompt.ts";
import {
  kbAddAssetTool,
  kbEditEntryTool,
  kbReadAssetTool,
  kbWriteEntryTool,
} from "./tools/knowledge/knowledgeBaseTools.ts";
import { projectRegistryReadTool } from "./tools/core/projectRegistryTools.ts";
import { eagerToolNamesFor } from "./tools/catalog.ts";
import { absent, affirmed, assertPromptRules } from "./test/promptRules.ts";

/**
 * KB 284/286: KB guidance lives on the deferred kb_* tool descriptions; the
 * eager section is a compact pointer that makes the tools discoverable and
 * restates none of their rules.
 */
test("the KB pointer and tool descriptions state the KB rules", () => {
  const noSecrets = /never (store|save|record|keep)[^.\n]*secrets/i;
  assertPromptRules({
    "eager pointer": {
      text: knowledgeBaseBehaviorGuidance(),
      rules: {
        // check:prompts budgets whole prompts; this one section has its own cap.
        "fits-600-chars": (text) => text.length <= 600,
        "names-kb_search": /kb_search/,
        "names-kb_get_entry": /kb_get_entry/,
        "names-kb_write_entry": /kb_write_entry/,
        "names-kb_edit_entry": /kb_edit_entry/,
        "tools-load-via-tool-search": /tool search/i,
        "search-before-answering-durable":
          /search[^.\n]*before answering[^.\n]*durable/i,
        "forbids-raw-fs-writes":
          /never (edit|write)[^.\n]*DATA_DIR\/knowledge/i,
        "no-obsolete-knowledge_*-tools": absent(/knowledge_[a-z]/),
        "no-restated-write-rule": absent(/durable long-form/i),
        "no-restated-scoping-rule": absent(/separate entries/i),
        "no-tool-local-asset-rule": absent(/kb_read_asset/),
      },
    },
    kb_write_entry: {
      text: kbWriteEntryTool.description,
      rules: {
        "for-durable-long-form": /durable long-form/i,
        "scopes-in-separate-entries":
          /separate[^.\n]*entries|entries[^.\n]*separate/i,
        "tags-avoid-cross-contamination": affirmed(
          /(?<key>avoid|prevent)[^.\n]*cross-contaminat/i,
        ),
        "never-invent-entry-ids": /never invent[^.\n]*\bids?\b/i,
        "links-via-pa-uris": /pa:\/\//,
        "no-secrets": noSecrets,
        "records-provenance": /provenance/i,
        "marks-uncertain-facts": /mark[^.\n]*uncertain/i,
        "atomic-facts-go-to-memory": affirmed(
          /belongs? in Memory|Memory[^.\n]*not the KB/i,
        ),
        "asks-on-ambiguity-or-conflict":
          /ask (first|before)[^.\n]*(ambiguous|conflict)/i,
      },
    },
    kb_edit_entry: {
      text: kbEditEntryTool.description,
      rules: {
        "schema-is-1": /kb\.schema\s*=\s*1\b/,
        "type-enum": /kb\.type/,
        "status-enum": /kb\.status/,
        "error-names-the-field": /error[^.\n]*names[^.\n]*field/i,
        "no-secrets": noSecrets,
      },
    },
    kb_add_asset: {
      text: kbAddAssetTool.description,
      rules: { "no-secrets": noSecrets },
    },
    kb_read_asset: {
      text: kbReadAssetTool.description,
      rules: {
        "extracts-are-kb_read_extract": affirmed(
          /kb_read_extract[^.\n]*?(?<key>only)[^.\n]*GENERATED/,
        ),
      },
    },
    project_registry_read: {
      text: projectRegistryReadTool.description,
      rules: {
        "read-before-assuming": /before assuming/i,
        "weighs-match-evidence": /matchedBy.*confidence.*warnings/i,
        "no-match-is-said-not-invented": affirmed(
          /(?<premise>no registry match)[^.\n]*?(?<key>say)[^.\n]*?((instead of|rather than) invent|(never|not|don't) invent)/i,
        ),
      },
    },
  });
});

test("no kb_* read tool is eager, so the pointer's discovery rule is the only way in", () => {
  // Task-286 defers `knowledge-core`. If a read tool turns eager again, the
  // pointer's "load them with a tool search" rule is misleading.
  for (const persona of ["assistant", "developer"] as const) {
    const eager = eagerToolNamesFor(persona);
    for (const name of ["kb_search", "kb_get_entry"])
      assert.ok(!eager.has(name), `${name} is eager again for ${persona}`);
  }
});
