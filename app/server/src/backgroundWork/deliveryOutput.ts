import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deliveryRoot = join(
  tmpdir(),
  `pa-background-delivery-${process.pid}-${randomUUID()}`,
);

export interface BackgroundDeliveryOutputFile {
  path: string;
  cleanupPath: string;
}

/**
 * Move one bounded activity batch out of the prompt. The file exists only for
 * the prompted turn and is removed once that turn finishes or the notice is
 * discarded.
 */
export function writeBackgroundDeliveryOutput(
  lines: readonly string[],
  droppedEventCount: number,
): BackgroundDeliveryOutputFile | undefined {
  try {
    mkdirSync(deliveryRoot, { recursive: true, mode: 0o700 });
    chmodSync(deliveryRoot, 0o700);
    const root = join(deliveryRoot, randomUUID());
    mkdirSync(root, { mode: 0o700 });
    const path = join(root, "output.txt");
    const dropped =
      droppedEventCount > 0
        ? `\n[${droppedEventCount} event(s) dropped by the bounded monitor buffer]\n`
        : "";
    writeFileSync(path, `${lines.join("\n")}${dropped}`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return { path, cleanupPath: root };
  } catch {
    return undefined;
  }
}

export function removeBackgroundDeliveryOutput(cleanupPath: string): void {
  if (!cleanupPath.startsWith(`${deliveryRoot}/`)) return;
  try {
    rmSync(cleanupPath, { recursive: true, force: true });
  } catch {
    // Delivery output is ephemeral; boot cleanup handles a crashed owner.
  }
}
