import { Boxes } from "lucide-react";
import {
  CLAUDE_SDK_PROVIDER,
  isOpenAiCompatibleModelProvider,
} from "@assistant/shared";
import { ProviderMark, type ProviderBrand } from "./ProviderMark.tsx";

/**
 * Map a (possibly granular) provider id onto one of the brand families we draw a
 * mark for. pi's provider ids are granular (e.g. `github-copilot`,
 * `openai-codex`); the two Claude-driven kinds (`claude`, `claude-sdk`) map to
 * Anthropic. Unknown providers, and every OpenAI-compatible endpoint account
 * (whatever server it points at), fall back to a neutral generic icon.
 */
function providerBrand(provider: string): ProviderBrand {
  const p = provider.toLowerCase();
  if (p === CLAUDE_SDK_PROVIDER) return "anthropic";
  if (isOpenAiCompatibleModelProvider(p)) return "generic";
  if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
  if (p.includes("github") || p.includes("copilot")) return "github";
  if (p.includes("openai") || p.includes("codex") || p.includes("gpt"))
    return "openai";
  return "generic";
}

export interface ProviderIconProps {
  /** Provider id (granular pi id or one of the Claude providers). */
  provider: string;
  /** Width and height in pixels. Defaults to `16`. */
  size?: number;
  /** Accessible label. Defaults to the provider id. */
  title?: string;
  /** Extra classes (color is inherited via `currentColor`). */
  className?: string;
}

/**
 * A small monochrome brand mark for a model provider. Inherits `currentColor`,
 * so color it with text utilities like any icon. Unknown providers render a
 * neutral generic glyph.
 */
export function ProviderIcon({
  provider,
  size = 16,
  title,
  className,
}: ProviderIconProps) {
  const brand = providerBrand(provider);
  if (brand === "generic") {
    return (
      <Boxes size={size} className={className} aria-label={title ?? provider} />
    );
  }
  return (
    <ProviderMark
      brand={brand}
      size={size}
      title={title ?? provider}
      {...(className ? { className } : {})}
    />
  );
}
