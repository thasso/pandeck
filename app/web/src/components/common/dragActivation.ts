/**
 * When a press becomes a drag-to-reorder, for every list that has one (`Tree`,
 * the Sessions inbox). A mouse starts after a small intentional movement, so a
 * click still clicks. Touch must HOLD, so a drag cannot be mistaken for
 * scrolling, tapping or a row swipe; the tolerance cancels the hold if the
 * finger drifts before the delay elapses.
 */
export const MOUSE_DRAG_DISTANCE_PX = 4;
export const TOUCH_LONG_PRESS_DELAY_MS = 500;
export const TOUCH_LONG_PRESS_TOLERANCE_PX = 8;
