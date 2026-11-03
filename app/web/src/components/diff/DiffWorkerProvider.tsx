/**
 * Shared @pierre/diffs worker-pool wiring. The React surfaces still build the
 * light diff/file metadata on the main thread, but Shiki tokenization and HAST
 * rendering run in the worker pool and can be cached by each surface's
 * content/patch-derived cacheKey.
 *
 * Highlighting is a background refinement, never a wait: the surfaces draw
 * their plain text at once and take the colours when the workers answer, so
 * nothing announces the work in progress.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  WorkerPoolContextProvider,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import type { WorkerStats } from "@pierre/diffs/worker";
import PierreDiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { Prefs } from "../../hooks/usePrefs.ts";

const DIFF_THEMES = {
  light: "catppuccin-latte",
  dark: "catppuccin-mocha",
} as const;

const workerCount = Math.max(
  1,
  Math.min(
    4,
    Math.floor(
      (typeof navigator === "undefined"
        ? 4
        : navigator.hardwareConcurrency || 4) / 2,
    ),
  ),
);

export const POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () => new PierreDiffWorker(),
  poolSize: workerCount,
  totalASTLRUCacheSize: 100,
};

// Takes the one preference it reads, not the whole `Prefs`: the memo below
// rebuilds on `diffWordLevel` alone, and a wider parameter would only make that
// dependency list look wrong.
export function highlighterOptionsFor(
  wordLevel: boolean,
): WorkerInitializationRenderOptions {
  return {
    theme: DIFF_THEMES,
    lineDiffType: wordLevel ? "word" : "none",
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    maxLineDiffLength: 1_000,
    preferredHighlighter: "shiki-js",
  };
}

function WorkerRenderOptionsSync({
  options,
}: {
  options: WorkerInitializationRenderOptions;
}) {
  const pool = useWorkerPool();

  useEffect(() => {
    if (!pool) return;
    pool.setRenderOptions(options).catch((err: unknown) => {
      console.warn("Failed to update diff worker render options", err);
    });
  }, [pool, options]);

  return null;
}

interface DiffWorkerStatusContextValue {
  stats: WorkerStats | null;
  completionVersion: number;
}

const DiffWorkerStatusContext =
  createContext<DiffWorkerStatusContextValue | null>(null);

function isWorkerBusy(stats: WorkerStats | null): boolean {
  if (!stats) return false;
  return (
    stats.managerState !== "initialized" ||
    stats.activeTasks > 0 ||
    stats.queuedTasks > 0
  );
}

function DiffWorkerStateProvider({ children }: { children: ReactNode }) {
  const pool = useWorkerPool();
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [completionVersion, setCompletionVersion] = useState(0);
  const wasBusy = useRef(false);

  useEffect(() => {
    if (!pool) {
      setStats(null);
      wasBusy.current = false;
      return;
    }
    return pool.subscribeToStatChanges((next) => {
      const busy = isWorkerBusy(next);
      setStats(next);
      if (wasBusy.current && !busy)
        setCompletionVersion((version) => version + 1);
      wasBusy.current = busy;
    });
  }, [pool]);

  const value = useMemo(
    () => ({ stats, completionVersion }),
    [stats, completionVersion],
  );

  return (
    <DiffWorkerStatusContext.Provider value={value}>
      {children}
    </DiffWorkerStatusContext.Provider>
  );
}

/**
 * Whether the pool can draw. Until then Pierre renders nothing — not even
 * plain text — so a surface shows its own raw stand-in (`PlainSurface`).
 */
export function useDiffWorkerReady(): boolean {
  const pool = useWorkerPool();
  const stats = useContext(DiffWorkerStatusContext)?.stats;
  return (
    !pool ||
    !pool.isWorkingPool() ||
    pool.isInitialized() ||
    stats?.managerState === "initialized"
  );
}

export function useDiffWorkerCompletionVersion(): number {
  return useContext(DiffWorkerStatusContext)?.completionVersion ?? 0;
}

export function DiffWorkerProvider({
  prefs,
  children,
}: {
  prefs: Prefs;
  children: ReactNode;
}) {
  const existingPool = useWorkerPool();
  const existingStatus = useContext(DiffWorkerStatusContext);
  const highlighterOptions = useMemo(
    () => highlighterOptionsFor(prefs.diffWordLevel),
    [prefs.diffWordLevel],
  );

  if (existingPool) {
    return (
      <>
        <WorkerRenderOptionsSync options={highlighterOptions} />
        {existingStatus ? (
          children
        ) : (
          <DiffWorkerStateProvider>{children}</DiffWorkerStateProvider>
        )}
      </>
    );
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={highlighterOptions}
    >
      <WorkerRenderOptionsSync options={highlighterOptions} />
      <DiffWorkerStateProvider>{children}</DiffWorkerStateProvider>
    </WorkerPoolContextProvider>
  );
}
