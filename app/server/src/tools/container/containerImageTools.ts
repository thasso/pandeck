/**
 * Container image tool (coding personas, gate `github`): `container_image_pull`
 * makes a registry image available in the host's local Docker image store so a
 * worktree build can use it.
 *
 * The agent never gets registry credentials: the pull runs server-side in
 * `../../containerImages.ts`, which uses the GitHub integration token for
 * `ghcr.io` only and destroys its temporary docker config afterwards. Plain
 * `docker pull` from an agent shell stays unauthenticated by design.
 */
import {
  ContainerPullError,
  DEFAULT_PULL_TIMEOUT_MS,
  findLocalContainerImage,
  type ContainerPullResult,
  containerRuntimeStatus,
  parseImageRef,
  pullContainerImage,
} from "../../containerImages.ts";
import { getGithubRegistryCredential } from "../../githubSettings.ts";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";

import { launchServerTask } from "../../serverTasks.ts";

type PullImageParams = {
  image: string;
  refresh?: boolean;
  background?: boolean;
};

export const containerImagePullTool = defineAgentTool<PullImageParams>({
  name: "container_image_pull",
  label: "Container: Pull Image",
  description:
    "Pull a container image onto this host so builds can use it. Use this instead of `docker pull` for private registry images (e.g. ghcr.io): registry credentials are applied server-side and never reach your shell. Afterwards the image is available to ordinary `docker run`/build scripts — bind-mount a checkout into one only with `--user $(id -u):$(id -g)` and a writable HOME, since a container writing as root leaves files only root can delete. Never ask the user for a registry token — the server holds it. Large pulls can take minutes; background runs the pull as PA background work and returns at once.",
  searchHint: "docker container image pull registry ghcr private builder image",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["image"],
    properties: {
      image: {
        type: "string",
        description:
          "Full image reference, e.g. ghcr.io/owner/name:1.2.3 or name@sha256:<digest>.",
      },
      background: {
        type: "boolean",
        description:
          "Pull as PA background work instead of blocking this turn. Returns a taskId, or the result inline if already present. The final JSON arrives automatically and is kept as its output file. Ending your turn does not stop it; background_tasks stop does. Bounded by the Settings background lifetime and the pull's 15-minute limit. Only an interactive top-level session may start one.",
      },
      refresh: {
        type: "boolean",
        description:
          "Pull again even when the image is already present locally. Defaults to false.",
      },
    },
  },
  async execute(params, ctx) {
    const ref = parseImageRef(params.image);
    const runtime = await containerRuntimeStatus(ctx.signal);
    if (!runtime.available) {
      throw new Error(
        `No container runtime is available on the server: ${runtime.reason || "docker is unavailable"}.`,
      );
    }
    try {
      if (params.background === true) {
        if (!params.refresh) {
          const present = await findLocalContainerImage(
            ref.normalized,
            ctx.signal,
          );
          if (present) return jsonResult(pullPayload(present));
        }
        return jsonResult(
          await launchServerTask({
            ctx,
            kind: "image-pull",
            label: `Image pull ${ref.normalized}`,
            command: `container_image_pull ${ref.normalized}${params.refresh ? " --refresh" : ""}`,
            sourceTool: "container_image_pull",
            requestedTimeoutMs: DEFAULT_PULL_TIMEOUT_MS,
            async run(budget) {
              const result = await pullContainerImage({
                image: ref.normalized,
                refresh: params.refresh === true,
                credential: getGithubRegistryCredential,
                signal: budget.signal,
                timeoutMs: budget.timeoutMs,
              });
              return {
                payload: pullPayload(result),
                summary:
                  result.status === "already-present"
                    ? `${result.image} was already present`
                    : `Pulled ${result.image} in ${Math.round(result.durationMs / 1_000)} s`,
              };
            },
          }),
        );
      }
      const result = await pullContainerImage({
        image: ref.normalized,
        refresh: params.refresh === true,
        credential: getGithubRegistryCredential,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.progress
          ? {
              onProgress: (message: string) =>
                ctx.progress?.({ content: [{ type: "text", text: message }] }),
            }
          : {}),
      });
      return jsonResult(pullPayload(result));
    } catch (err) {
      // ContainerPullError messages are already bounded and redacted.
      if (err instanceof ContainerPullError) throw new Error(err.message);
      throw err;
    }
  },
});

function pullPayload(result: ContainerPullResult) {
  return {
    image: result.image,
    registry: result.registry,
    status: result.status,
    digest: result.digest,
    imageId: result.imageId,
    sizeBytes: result.sizeBytes,
    authenticated: result.authenticated,
    durationMs: result.durationMs,
    note:
      result.status === "already-present"
        ? "Image was already in the local store; builds can use it as is."
        : "Image is now in the local store; builds can use it without any registry credentials.",
  };
}

export const containerImageTools = [containerImagePullTool];
