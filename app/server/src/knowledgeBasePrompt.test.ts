import assert from "node:assert/strict";
import { test } from "vitest";
import { knowledgeBaseBehaviorGuidance } from "./knowledgeBasePrompt.ts";
import {
  kbEditTool,
  kbReadTool,
  kbWriteTool,
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
        "names-kb_read": /kb_read/,
        "names-kb_write": /kb_write/,
        "names-kb_edit": /kb_edit/,
        "tools-load-via-tool-search": /tool search/i,
        "search-before-answering-durable":
          /search[^.\n]*before answering[^.\n]*durable/i,
        "forbids-raw-fs-writes":
          /never (edit|write)[^.\n]*DATA_DIR\/knowledge/i,
        "no-obsolete-entry-tools": absent(/kb_[a-z]+_entry|kb_get_entry/),
        "no-restated-write-rule": absent(/never store/i),
        "no-tool-local-binary-rule": absent(/sourceAttachmentId/),
      },
    },
    kb_write: {
      text: kbWriteTool.description,
      rules: {
        "for-durable-knowledge": /knowledge: notes/i,
        "reuses-existing-files": /reuse existing files[^.\n]*kb_search/i,
        "links-via-pa-uris": /pa:\/\/knowledge\/<path>/,
        "no-secrets": noSecrets,
        "says-where-facts-came-from": /where a fact came from/i,
        "marks-uncertain-facts": /mark[^.\n]*uncertain/i,
        "atomic-facts-go-to-memory": affirmed(
          /belongs? in Memory|Memory[^.\n]*not here/i,
        ),
        "asks-on-ambiguity-or-conflict":
          /ask (first|before)[^.\n]*(ambiguous|conflict)/i,
        "refuses-uncommitted-user-edits": /without committing is refused/i,
        "copies-attachments-server-side": /sourceAttachmentId/,
      },
    },
    kb_edit: {
      text: kbEditTool.description,
      rules: {
        "exact-unique-replacements": /exactly once/i,
        "no-secrets": noSecrets,
        "refuses-uncommitted-user-edits": /without committing is refused/i,
      },
    },
    kb_read: {
      text: kbReadTool.description,
      rules: {
        "binary-files-go-to-converters": /convert_pdf[^.\n]*convert_xlsx/,
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
    for (const name of ["kb_search", "kb_read"])
      assert.ok(!eager.has(name), `${name} is eager again for ${persona}`);
  }
});
