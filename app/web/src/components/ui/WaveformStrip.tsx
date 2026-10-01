import { useEffect, useRef } from "react";
import type { PeakRing } from "../../lib/waveform.ts";

/**
 * The live dictation trace, drawn in the collapsed composer bar.
 *
 * Canvas rather than DOM bars: this repaints ~40 times a second, and doing that
 * through React state or dozens of styled elements would re-render the composer
 * (and re-layout the bar) for what is a single small picture. The component reads
 * the peak ring inside its OWN animation frame and never re-renders while
 * recording — the ring's `version` tells it whether anything actually changed.
 *
 * It answers exactly one question: is my voice arriving? A flat trace while you
 * are talking says no, which is the whole reason it exists.
 */
export function WaveformStrip({
  peaks,
  active,
  className,
}: {
  peaks: PeakRing;
  /** Animate while true; freeze the last picture when false (e.g. transcribing). */
  active: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;
    let painted = -1;
    let width = 0;
    let height = 0;

    const draw = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Match the backing store to the CSS box, accounting for device pixels.
      const ratio = window.devicePixelRatio || 1;
      const box = canvas.getBoundingClientRect();
      const nextWidth = Math.max(1, Math.round(box.width * ratio));
      const nextHeight = Math.max(1, Math.round(box.height * ratio));
      const resized = nextWidth !== width || nextHeight !== height;
      if (resized) {
        width = nextWidth;
        height = nextHeight;
        canvas.width = width;
        canvas.height = height;
      }
      if (!resized && painted === peaks.version) return;
      painted = peaks.version;

      // Inherit the current text colour so the strip themes with the bar.
      const colour = window.getComputedStyle(canvas).color;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = colour;

      const barWidth = Math.max(1, Math.round(2 * ratio));
      const gap = Math.max(1, Math.round(1 * ratio));
      const stride = barWidth + gap;
      const visible = Math.max(1, Math.floor(width / stride));
      const values = peaks.toArray().slice(-visible);
      const mid = height / 2;
      // Right-align so the newest audio is at the leading edge, like a tape.
      const offset = width - values.length * stride;

      for (let i = 0; i < values.length; i++) {
        // A floor keeps silence visible as a baseline rather than a blank gap,
        // so "nothing is arriving" and "not recording" do not look identical.
        const magnitude = Math.max(0.04, Math.min(1, values[i]!));
        const barHeight = Math.max(ratio, magnitude * (height - 2 * ratio));
        ctx.fillRect(
          offset + i * stride,
          mid - barHeight / 2,
          barWidth,
          barHeight,
        );
      }
    };

    const loop = () => {
      draw();
      frame = window.requestAnimationFrame(loop);
    };

    if (active) {
      loop();
    } else {
      // Frozen: paint once more so the final shape stays on screen.
      painted = -1;
      draw();
    }
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [active, peaks]);

  // The canvas is absolutely positioned inside the box the caller sizes, so it
  // contributes NO width to its flex row. A canvas is a replaced element whose
  // backing store (`canvas.width`, in device pixels) is also its intrinsic size,
  // and iOS Safari sized the collapsed composer's recording row from it — pushing
  // the stop button off the bar's right edge — where Chromium shrank it correctly.
  // Out of flow, no engine can measure the row from the trace.
  return (
    <span className={`relative block ${className ?? ""}`}>
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0 block size-full"
      />
    </span>
  );
}
