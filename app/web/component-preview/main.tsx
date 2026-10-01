import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PaPreviewRoot } from "./PaPreviewRoot.tsx";
import { isStoryPreviewId, storyCatalog } from "./storyCatalog.ts";
import { renderStory } from "./storyRegistry.tsx";
import "./preview.css";

const storyId = __PA_PREVIEW_STORY__;
if (!isStoryPreviewId(storyId)) throw new Error(`Unknown story: ${storyId}`);
const definition = storyCatalog[storyId];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PaPreviewRoot theme={definition.theme} textScale={definition.textScale}>
      {renderStory(storyId)}
    </PaPreviewRoot>
  </StrictMode>,
);
