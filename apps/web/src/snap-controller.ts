// apps/web/src/snap-controller.ts

export type PaneChangeCallback = (pane: number) => void;

/** Pixel delta required to trigger a snap between panes 0 and 1. */
const SNAP_THRESHOLD = 20;

/**
 * Pixel delta required to escape the results pane (pane 2) by
 * scrolling up while at its top boundary.
 */
const RESULTS_ESCAPE_THRESHOLD = 80;

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
  /** Finger Y recorded the moment it first contacts the results top boundary.
   *  Escape distance is measured from here, not from touchStartY, so that
   *  momentum from scrolling up through results doesn't carry the user past. */
  private wallEntryY: number | null = null;
  private onPaneChange: PaneChangeCallback;
  private resizeObserver: ResizeObserver | null = null;

  constructor(onPaneChange: PaneChangeCallback) {
    this.onPaneChange = onPaneChange;
  }

  init(): void {
    this.destroy(); // self-healing: safe to call multiple times
    // Prevent iOS Safari from restoring a previous scroll position on page load.
    // Without this, Safari can restore e.g. scrollY=50 which causes the ingest
    // section to peek below the hero — the snap controller always manages position.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.computeSnapPositions();
    // Immediately lock to the current pane (guards against browser scroll restoration).
    window.scrollTo({ top: this.snapPositions[this.currentPane] ?? 0, behavior: 'instant' as ScrollBehavior });

    window.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('touchstart', this.handleTouchStart, { passive: true });
    window.addEventListener('touchmove', this.handleTouchMove, { passive: false });
    // Catches iOS momentum scroll carrying past the results top boundary after finger lift.
    window.addEventListener('scroll', this.handleScroll, { passive: true });

    // Recompute snap positions whenever ingest or results section resizes.
    this.resizeObserver = new ResizeObserver(() => {
      // Record how far the user has scrolled past the current pane top before
      // recalculating, so we can restore their position afterward. This prevents
      // new wine cards being appended from jumping the viewport back to the pane top.
      const prevPaneTop = this.snapPositions[this.currentPane] ?? 0;
      const scrolledBeyondPane = window.scrollY - prevPaneTop;

      this.computeSnapPositions();

      const newPaneTop = this.snapPositions[this.currentPane] ?? 0;
      if (scrolledBeyondPane > 5) {
        // User has scrolled into the pane content — preserve their relative offset.
        window.scrollTo({ top: newPaneTop + scrolledBeyondPane, behavior: 'instant' as ScrollBehavior });
      } else {
        // At or near the pane top — re-lock to the (possibly shifted) pane position.
        window.scrollTo({ top: newPaneTop, behavior: 'instant' as ScrollBehavior });
      }
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
    window.removeEventListener('scroll', this.handleScroll);
    this.resizeObserver?.disconnect();
  }

  snapTo(pane: 0 | 1 | 2): void {
    if (pane < 0 || pane > 2) return;
    this.computeSnapPositions(); // always use fresh positions — elements between panes can shift layout
    this.cooldown = true;
    this.accumulated = 0;
    this.currentPane = pane;
    this.onPaneChange(pane);
    const pos = this.snapPositions[pane] ?? 0;
    // Defer scroll to next animation frame so React's synchronous DOM flush
    // (triggered by onPaneChange) completes before the smooth scroll begins.
    // Without this, Chrome cancels the smooth scroll when React mutates the DOM
    // in the same event-handler tick.
    requestAnimationFrame(() => {
      window.scrollTo({ top: pos, behavior: 'smooth' });
    });
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

  // Catches momentum scroll (after finger lift) carrying past the results top boundary.
  // Touch events stop firing once the finger is lifted, so this scroll listener is the
  // only hook we have on iOS momentum.
  // Strategy: first call scrollTo at the *current* position with 'instant' — this has no
  // visible effect but kills iOS inertia. Then in the next frame, smoothly animate to the
  // boundary so the landing feels the same as the intentional auto-snap.
  private handleScroll = (): void => {
    if (this.cooldown) return;
    if (this.currentPane === 2 && window.scrollY < this.snapPositions[2] - 2) {
      this.cooldown = true;
      // Interrupt inertia without a visible jump.
      window.scrollTo({ top: window.scrollY, behavior: 'instant' as ScrollBehavior });
      // Smoothly land on the boundary in the next frame (after the instant call commits).
      requestAnimationFrame(() => {
        window.scrollTo({ top: this.snapPositions[2], behavior: 'smooth' });
      });
      setTimeout(() => { this.cooldown = false; }, SNAP_COOLDOWN_MS);
    }
  };

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
    // Reset accumulation and wall-entry at the start of each gesture.
    this.accumulated = 0;
    this.wallEntryY = null;
  };

  private handleTouchMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (!touch) return;
    const fingerY = touch.clientY;
    // Total delta from where this touch began (negative = finger moved down = scrolling up).
    const totalDelta = this.touchStartY - fingerY;

    if (this.currentPane === 2) {
      if (!(this.isAtResultsTop() && totalDelta < 0)) {
        // Not at the top boundary, or not pulling upward — let native scroll handle.
        // Also clear wall entry so a fresh contact point is recorded next time.
        this.wallEntryY = null;
        return; // do NOT preventDefault — keeps iOS momentum scrolling intact
      }

      // User has reached the top boundary and is pulling upward against it (the "wall").
      // Record the exact finger position the first time we detect this, so escape
      // distance is measured only from the wall contact point — not from wherever
      // the touch originally started deeper in the list.
      if (this.wallEntryY === null) {
        this.wallEntryY = fingerY;
      }

      e.preventDefault();
      // accumulated is negative and grows more negative the further past the wall.
      this.accumulated = this.wallEntryY - fingerY;
      this.checkSnap();
      return;
    }

    // Don't intercept touches on range inputs — let the browser deliver them
    // to the slider natively. Without this, e.preventDefault() below would
    // swallow the drag and the slider thumb would never move.
    if ((e.target as Element).tagName === 'INPUT') return;

    e.preventDefault();
    // For panes 0 & 1: measure against the original touch start as before.
    this.accumulated = totalDelta;
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
