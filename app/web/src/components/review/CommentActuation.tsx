import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** Domain-neutral comment affordances published by the active route surface. */
export interface CommentActuation {
  /** Whether the surface currently has a selection or structural target. */
  canComment?: boolean;
  /** Opens the surface-owned composer for its current target. */
  onComment?: () => void;
  /** Number of comments waiting to be submitted as one review. */
  pendingCount?: number;
  /** Opens the surface-owned review submission flow. */
  onSubmitReview?: () => void;
  /** What submitting is called here; "Submit review" by default. */
  submitLabel?: string;
  /**
   * That composer currently holds the surface's bottom edge. A phone has ONE
   * slot down there, so the shell stands its object dock down rather than
   * stacking a second row under the composer (`app/web/docs/ui-shell.md`).
   */
  composerOpen?: boolean;
}

interface PublishedActuation {
  source: object;
  value: CommentActuation;
}

interface CommentActuationContextValue {
  current: CommentActuation | null;
  publish: (source: object, value: CommentActuation) => void;
  clear: (source: object) => void;
}

const CommentActuationContext =
  createContext<CommentActuationContextValue | null>(null);

/**
 * Route-level channel between a commentable content surface and shell chrome.
 * The source token keeps an unmounting surface from clearing a newer publisher.
 */
export function CommentActuationProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [published, setPublished] = useState<PublishedActuation | null>(null);
  const publish = useCallback(
    (source: object, value: CommentActuation) =>
      setPublished({ source, value }),
    [],
  );
  const clear = useCallback(
    (source: object) =>
      setPublished((current) => (current?.source === source ? null : current)),
    [],
  );
  const contextValue = useMemo(
    () => ({ current: published?.value ?? null, publish, clear }),
    [clear, publish, published],
  );
  return (
    <CommentActuationContext.Provider value={contextValue}>
      {children}
    </CommentActuationContext.Provider>
  );
}

/** The affordances currently published by the active route surface. */
export function useCommentActuation(): CommentActuation | null {
  return useContext(CommentActuationContext)?.current ?? null;
}

/** Publish a surface's affordances for as long as that surface remains mounted. */
export function usePublishCommentActuation(value: CommentActuation | null) {
  const context = useContext(CommentActuationContext);
  const publish = context?.publish;
  const clear = context?.clear;
  const source = useRef<object>({}).current;
  const latestValue = useRef(value);
  latestValue.current = value;
  const runComment = useCallback(() => latestValue.current?.onComment?.(), []);
  const runSubmitReview = useCallback(
    () => latestValue.current?.onSubmitReview?.(),
    [],
  );
  const hasValue = Boolean(value);
  const hasComment = Boolean(value?.onComment);
  const hasSubmitReview = Boolean(value?.onSubmitReview);
  // The published shape is these fields and nothing else, so read them out here
  // rather than closing over `value`: the memo's dependencies are then exactly
  // what it renders, and a surface handing in a fresh object each render
  // republishes nothing.
  const canComment = value?.canComment;
  const pendingCount = value?.pendingCount;
  const composerOpen = value?.composerOpen;
  const submitLabel = value?.submitLabel;
  // Keep callback identity out of the channel: surfaces often close over their
  // current selection, and publishing a fresh closure must not make the route
  // provider and its surface re-render one another forever.
  const publishedValue = useMemo<CommentActuation | null>(
    () =>
      hasValue
        ? {
            ...(canComment !== undefined ? { canComment } : {}),
            ...(hasComment ? { onComment: runComment } : {}),
            ...(pendingCount !== undefined ? { pendingCount } : {}),
            ...(hasSubmitReview ? { onSubmitReview: runSubmitReview } : {}),
            ...(composerOpen !== undefined ? { composerOpen } : {}),
            ...(submitLabel !== undefined ? { submitLabel } : {}),
          }
        : null,
    [
      hasComment,
      hasSubmitReview,
      runComment,
      runSubmitReview,
      canComment,
      pendingCount,
      composerOpen,
      submitLabel,
      hasValue,
    ],
  );

  useLayoutEffect(() => {
    if (!publish || !clear || !publishedValue) return;
    publish(source, publishedValue);
    return () => clear(source);
  }, [clear, publish, publishedValue, source]);
}
