/** Shared admission across dictation and conversation in every mounted composer. */
export const microphoneOwner = {
  id: null as string | null,
  listeners: new Set<() => void>(),
  claim(id: string): boolean {
    if (this.id !== null && this.id !== id) return false;
    this.id = id;
    this.notify();
    return true;
  },
  release(id: string): void {
    if (this.id !== id) return;
    this.id = null;
    this.notify();
  },
  notify(): void {
    for (const listener of this.listeners) listener();
  },
};
