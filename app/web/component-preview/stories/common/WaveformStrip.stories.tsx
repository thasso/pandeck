import type { Meta, StoryObj } from "@storybook/react-vite";
import { PeakRing } from "../../../src/lib/waveform.ts";
import { WaveformStrip } from "../../../src/components/common/WaveformStrip.tsx";
const peaks = new PeakRing(32);
peaks.push([
  0.12, 0.35, 0.68, 0.42, 0.91, 0.53, 0.24, 0.74, 0.48, 0.82, 0.3, 0.61, 0.95,
  0.45, 0.2, 0.72, 0.38, 0.84, 0.56, 0.28, 0.67, 0.43, 0.9, 0.32,
]);
const meta = {
  title: "Common/WaveformStrip",
  component: WaveformStrip,
} satisfies Meta<typeof WaveformStrip>;
export default meta;
export const Recording = {
  args: { peaks, active: true, className: "h-10 w-64 text-primary" },
} satisfies StoryObj<typeof meta>;
