/**
 * The edge's result vetting (Task-1463 P6a, P6-F1): the `ResultVetting` the
 * result contracts (`jiraMutationResult.ts`, `confluenceMutationResult.ts`)
 * take, closed over one call's credential. It is the one-call projection's
 * own rules (`writeResult.ts`, P4b2 A1 and P5b C1), never a copy: an
 * identifier passes `holdsSecret` on its raw value first and only then its
 * format (`IDENTIFIER_FORMATS`); a link needs a backing identifier that
 * passed, the credential's site, and a clean raw form and decodings; a text
 * is `vettedText`. Built fresh per call, with no module state.
 *
 * Imported only from `gatewayTools/` (`workerBoundary.test.ts`).
 */
import {
  IDENTIFIER_FORMATS,
  type ResultVetting,
} from "../mutationResultCodec.ts";
import type { AtlassianCredential } from "./descriptor.ts";
import { projectText, vettedIdentifier, vettedUrl } from "./writeResult.ts";

export function vettingFor(credential: AtlassianCredential): ResultVetting {
  return {
    identifier: (raw, kind) =>
      vettedIdentifier(raw, credential, IDENTIFIER_FORMATS[kind]),
    url: (raw, backing) => vettedUrl(raw, backing, credential),
    text: (raw, max, fallback) => projectText(raw, credential, max, fallback),
  };
}
