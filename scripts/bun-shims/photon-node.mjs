import { createRequire } from "node:module";
import { join } from "node:path";
import { RUNTIME_ASSET_ROOT } from "../../app/server/src/runtimeAssets.ts";

const require = createRequire(import.meta.url);
const photon = require(
  join(RUNTIME_ASSET_ROOT, "native", "photon", "photon_rs.js"),
);

export const PhotonImage = photon.PhotonImage;
export const SamplingFilter = photon.SamplingFilter;
export const resize = photon.resize;
export const fliph = photon.fliph;
export const flipv = photon.flipv;
