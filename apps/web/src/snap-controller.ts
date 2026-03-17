// apps/web/src/snap-controller.ts

export type PaneChangeCallback = (pane: number) => void;

/** Pixel delta required to trigger a snap between panes 0 and 1. */
const SNAP_THRESHOLD = 35;

/**
 * Pixel delta required to escape the results pane (pane 2) by
 * scrolling up while at its top boundary.
 */
const RESULTS_ESCAPE_THRESHOLD = 60;

/**
 * How long (ms) to ignore new scroll events after a snap fires.
 * 900ms covers the smooth scroll animation even for the longest jump
 * (hero → results = ~2× viewport height).
 */
const SNAP_COOLDOWN_MS = 900;

export class SnapController {
  private currentPane = 0;
  private snapPositions: [number, number, number] = [0, 0, 0];
  private accumulated = 0;
  private cooldown = false;
  private touchStartY = 0;
  private onPaneChange: PaneChangeCallback;
  private resizeObserver: ResizeObserver | null = null;

  constructor(onPaneChange: PaneChangeCallback) {
    this.onPaneChange = onPaneChange;
  }

  init(): void {
    this.destroy(); // self-healing: safe to call multiple times
    this.computeSnapPositions();

    window.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    window.addEventListener('touchmove', this.handleTouchMove, { passive: false });

    // Recompute snap positions whenever ingest or results section resizes.
    // Re-snap to current pane so viewport stays locked.
    this.resizeObserver = new ResizeObserver(() => {
      this.computeSnapPositions();
      // Immediately re-lock viewport to current pane (handles content expansion).
      const pos = this.snapPositions[this.currentPane] ?? 0;
      window.scrollTo({ top: pos, behavior: 'instant' as ScrollBehavior }); // 'instant' may not be in older TS lib.dom
    });

    const ingest = document.getElementById('ingest');
    const results = document.getElementById('results');
    if (ingest) this.resizeObserver.observe(ingest);
    if (results) this.resizeObserver.observe(results);
  }

  destroy(): void {
    // Safe to call before init() — removeEventListener on unregistered handlers is a no-op.
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('touchstart', this.handleTouchStart);
    window.removeEventListener('touchmove', this.handleTouchMove);
    this.resizeObserver?.disconnect();
  }

  snapTo(pane: 0 | 1 | 2): void {
    if (pane < 0 || pane > 2) return;
    this.cooldown = true;
    this.accumulated = 0;
    this.currentPane = pane;
    this.onPaneChange(pane);
    const pos = this.snapPositions[pane] ?? 0;
    window.scrollTo({ top: pos, behavior: 'smooth' });
    setTimeout(() => { this.cooldown = false; }, SNAP_COOLDOWN_MS);
  }

  private computeSnapPositions(): void {
    const nav = document.querySelector<HTMLElement>('.site-nav');
    const ingest = document.getElementById('ingest');
    const results = document.getElementById('results');
    const navH = nav?.getBoundingClientRect().height ?? 56;

    this.snapPositions = [
      0, // pane 0 (hero) is always the top of the document — no element lookup needed
      ingest ? ingest.getBoundingClientRect().top + window.scrollY - navH : 0,
      results ? results.getBoundingClientRect().top + window.scrollY - navH : 0,
    ];
  }

  private handleWheel = (e: WheelEvent): void => {
    // In results pane, only intercept at top boundary scrolling up.
    if (this.currentPane === 2 && !(this.isAtResultsTop() && e.deltaY < 0)) {
      return; // let native scroll handle
    }
    e.preventDefault();
    this.trySnap(e.deltaY);
  };

  private handleTouchStart = (e: TouchEvent): void => {
    this.touchStartY = e.touches[0]?.clientY ?? this.touchStartY;
    // Reset accumulation at the start of each gesture so stale deltas from a
    // previous swipe never influence the next one.
    this.accumulated = 0;
  };

  private handleTouchMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;
    // Use total distance from touchstart (not incremental per-frame).
    // This means a 35px swipe always feels like a 35px swipe regardless of
    // how fast the finger moves or how many frames fired.
    const delta = this.touchStartY - touch.clientY;

    // In pane 2 (results): only suppress native scroll when the user is at the
    // top boundary AND swiping up (delta < 0 = finger moving down = scrolling up).
    // All other touches in pane 2 must NOT call preventDefault so native scroll
    // operates normally over the wine list. Calling preventDefault here when not
    // needed would block iOS momentum scrolling in results.
    if (this.currentPane === 2 && !(this.isAtResultsTop() && delta < 0)) {
      return; // do NOT call preventDefault — let native scroll handle it
    }
    e.preventDefault();
    // Set accumulated directly to total swipe distance (not additive) so the
    // threshold check is always against the real swipe distance.
    this.accumulated = delta;
    this.checkSnap();
  };

  // Called by wheel handler — additively accumulates delta then checks threshold.
  private trySnap(delta: number): void {
    if (this.cooldown) return;

    if (this.currentPane === 2) {
      if (delta < 0 && this.isAtResultsTop()) {
        this.accumulated += delta;
        if (this.accumulated < -RESULTS_ESCAPE_THRESHOLD) this.snapTo(1);
      } else {
        this.accumulated = 0;
      }
      return;
    }

    this.accumulated += delta;
    this.checkSnap();
  }

  // Called by touch handler (accumulated already set) and by trySnap.
  // Fires a snap if accumulated has crossed the threshold.
  private checkSnap(): void {
    if (this.cooldown) return;
    if (this.currentPane === 2) {
      if (this.accumulated < -RESULTS_ESCAPE_THRESHOLD) this.snapTo(1);
      return;
    }
    if (this.accumulated > SNAP_THRESHOLD && this.currentPane < 2) {
      this.snapTo((this.currentPane + 1) as 0 | 1 | 2);
    } else if (this.accumulated < -SNAP_THRESHOLD && this.currentPane > 0) {
      this.snapTo((this.currentPane - 1) as 0 | 1 | 2);
    }
  }

  private isAtResultsTop(): boolean {
    return window.scrollY <= this.snapPositions[2] + 5;
  }
}
