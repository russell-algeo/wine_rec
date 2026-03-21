// apps/web/src/snap-controller.ts

export type PaneChangeCallback = (pane: number) => void;

/** Pixel delta required to trigger a snap between panes 0 and 1. */
const SNAP_THRESHOLD = 20;

/**
 * Pixel delta required to escape the results pane (pane 2) via touch —
 * measured from the wall contact point, so momentum after finger lift
 * doesn't contribute.
 */
const RESULTS_ESCAPE_THRESHOLD = 80;

/**
 * Accumulated wheel deltaY (across multiple spring cycles) required to
 * escape from results back to ingest. Builds up as the user repeatedly
 * pushes upward against the wall; resets on any pane change or when
 * scrolling back into results.
 */
const WHEEL_RESULTS_ESCAPE_THRESHOLD = 400;

/**
 * Debounce duration for the snap-entry guard: how long (ms) after the
 * last downward wheel event the guard stays active to block residual
 * trackpad momentum from drifting the page down past the snap point.
 */
const WHEEL_BOUNCE_DELAY_MS = 80;

/**
 * Recoil-specific guard duration after the results-top spring settles.
 * Desktop trackpad inertia can deliver a straggling upward pulse a few
 * hundred milliseconds later, so this must be longer than the generic
 * wheel debounce used for snap-entry protection.
 */
const WHEEL_RECOIL_GUARD_MS = 400;

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
  /**
   * Current scrollY that the active results-top spring owns. Desktop fling
   * inertia can still deliver non-cancelable upward scroll during the spring;
   * clamp those events back to this trajectory instead of letting them punch
   * a second dip above the wall.
   */
  private activeSpringY: number | null = null;
  /**
   * Snap-entry guard: armed whenever we snap INTO pane 2 to block residual
   * downward trackpad momentum from drifting the page past the snap point.
   * Extends itself on each arriving downward event (debounce), so it adapts
   * to gesture strength. Clears WHEEL_BOUNCE_DELAY_MS after the last event.
   */
  private snapEntryGuardTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Wall-recoil guard: armed when the results-top spring settles to block
   * residual upward trackpad momentum from triggering a second spring.
   * Extends itself on each arriving upward event (debounce) so it adapts to
   * gesture strength. Clears WHEEL_BOUNCE_DELAY_MS after the last event.
   */
  private wallRecoilGuardTimer: ReturnType<typeof setTimeout> | null = null;

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
    // Catches momentum scroll carrying past the results top boundary — both
    // iOS finger-lift inertia and desktop wheel scroll that we let through.
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
      const newScrollY = scrolledBeyondPane > 5
        ? newPaneTop + scrolledBeyondPane
        : newPaneTop;
      // Only call scrollTo if the position actually changed — even an identical
      // scrollTo({ behavior: 'instant' }) call kills iOS momentum scrolling.
      if (Math.abs(newScrollY - window.scrollY) > 1) {
        window.scrollTo({ top: newScrollY, behavior: 'instant' as ScrollBehavior });
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
    if (this.snapEntryGuardTimer !== null) clearTimeout(this.snapEntryGuardTimer);
    if (this.wallRecoilGuardTimer !== null) clearTimeout(this.wallRecoilGuardTimer);
    this.snapEntryGuardTimer = null;
    this.wallRecoilGuardTimer = null;
  }

  /** Arm (or re-arm) the snap-entry guard for pane 2. */
  private armSnapEntryGuard(): void {
    if (this.snapEntryGuardTimer !== null) clearTimeout(this.snapEntryGuardTimer);
    this.snapEntryGuardTimer = setTimeout(() => {
      this.snapEntryGuardTimer = null;
    }, WHEEL_BOUNCE_DELAY_MS);
  }

  /** Arm (or re-arm) the wall-recoil guard after the spring settles. */
  private armWallRecoilGuard(): void {
    if (this.wallRecoilGuardTimer !== null) clearTimeout(this.wallRecoilGuardTimer);
    this.wallRecoilGuardTimer = setTimeout(() => {
      this.wallRecoilGuardTimer = null;
    }, WHEEL_RECOIL_GUARD_MS);
  }

  /**
   * Release the spring cooldown only after seeding a fresh recoil guard.
   * On desktop, trackpad inertia can outlive the spring animation itself.
   */
  private releaseSpringCooldown(): void {
    this.activeSpringY = null;
    this.armWallRecoilGuard();
    this.cooldown = false;
  }

  snapTo(pane: 0 | 1 | 2): void {
    if (pane < 0 || pane > 2) return;
    this.cooldown = true;
    this.accumulated = 0;
    this.currentPane = pane;
    this.onPaneChange(pane);
    // Arm the snap-entry guard when entering results so residual downward
    // momentum from the triggering gesture cannot drift the page past the top.
    if (pane === 2) this.armSnapEntryGuard();
    // Defer scroll to next animation frame so React's synchronous DOM flush
    // (triggered by onPaneChange) completes before the smooth scroll begins.
    // Without this, Chrome cancels the smooth scroll when React mutates the DOM
    // in the same event-handler tick. Computing positions here (inside the rAF)
    // also ensures we use post-commit layout rather than pre-commit values.
    requestAnimationFrame(() => {
      this.computeSnapPositions();
      const pos = this.snapPositions[pane] ?? 0;
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
      ingest ? Math.ceil(ingest.getBoundingClientRect().top + window.scrollY - navH) : 0,
      results ? Math.ceil(results.getBoundingClientRect().top + window.scrollY - navH) : 0,
    ];
  }

  // Catches momentum scroll carrying past the results top boundary — used by
  // both the iOS touch path (finger-lift inertia) and the desktop wheel path
  // (upward events we let through so native scroll moves the page naturally).
  private handleScroll = (): void => {
    if (this.currentPane !== 2) return;
    if (window.scrollY >= this.snapPositions[2] - 2) return;

    // While the spring is already running, ignore any browser momentum that
    // tries to shove the page farther above the wall than the spring itself.
    // This is the remaining desktop bug: those late fling pulses are often
    // non-cancelable, so wheel.preventDefault() cannot stop them.
    if (this.activeSpringY !== null) {
      if (window.scrollY < this.activeSpringY - 1) {
        window.scrollTo({ top: this.activeSpringY, behavior: 'instant' as ScrollBehavior });
      }
      return;
    }

    // Some browser-generated fling wheel events are non-cancelable on desktop.
    // If one slips through after the spring has already settled, clamp it
    // straight back to the wall instead of launching a second visible spring.
    if (!this.cooldown && this.wallRecoilGuardTimer !== null) {
      window.scrollTo({ top: this.snapPositions[2], behavior: 'instant' as ScrollBehavior });
      return;
    }

    if (this.cooldown) return;
    const rawOverscroll = this.snapPositions[2] - window.scrollY;
    // Stretch factor: makes the page travel 2× as far for the same momentum,
    // giving the spring snap-back its elastic feel on both iOS and desktop.
    const stretchedOverscroll = rawOverscroll * 2;
    window.scrollTo({ top: this.snapPositions[2] - stretchedOverscroll, behavior: 'instant' as ScrollBehavior });
    this.springSnapBack(this.snapPositions[2], stretchedOverscroll);
  };

  /**
   * Critically-damped spring snap-back matching Apple's UIScrollView rubber-band physics.
   *
   * Formula (reverse-engineered from UIKit — Arek Holko / Ilya Lobanov):
   *   x(t) = x₀ · (1 + ω·t) · e^(−ω·t)
   *
   * ω = 9.375 rad/s
   */
  private springSnapBack = (targetY: number, overscrollPx: number): void => {
    this.cooldown = true;
    const OMEGA = 9.375;
    const x0 = -overscrollPx; // negative: we are above targetY in scrollY space
    this.activeSpringY = targetY + x0;
    const startTime = performance.now();
    let done = false;

    const frame = () => {
      if (done) return;
      const t = (performance.now() - startTime) / 1000; // ms → seconds
      const x = x0 * (1 + OMEGA * t) * Math.exp(-OMEGA * t);
      this.activeSpringY = targetY + x;

      if (Math.abs(x) < 0.5) {
        done = true;
        this.activeSpringY = targetY;
        window.scrollTo({ top: targetY, behavior: 'instant' as ScrollBehavior });
        setTimeout(() => { this.releaseSpringCooldown(); }, 100);
        return;
      }

      window.scrollTo({ top: targetY + x, behavior: 'instant' as ScrollBehavior });
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
    setTimeout(() => {
      if (!done) {
        done = true;
        this.activeSpringY = targetY;
        window.scrollTo({ top: targetY, behavior: 'instant' as ScrollBehavior });
        this.releaseSpringCooldown();
      }
    }, 1500);
  };

  private handleWheel = (e: WheelEvent): void => {
    if (this.currentPane === 2) {
      // During cooldown (spring or snap animation), block all wheel events so
      // native momentum can't fight our position management. Keep the snap-entry
      // guard alive for any downward events still arriving; keep the wall-recoil
      // guard alive for upward events so the guard extends through the full spring.
      if (this.cooldown) {
        e.preventDefault();
        if (e.deltaY > 0) this.armSnapEntryGuard();
        if (e.deltaY < 0) this.armWallRecoilGuard();
        return;
      }

      // Snap-entry guard: block residual downward momentum after snapping to
      // results. Self-adapts to gesture strength via debounce re-arming.
      if (this.snapEntryGuardTimer !== null && e.deltaY > 0) {
        e.preventDefault();
        this.armSnapEntryGuard();
        return;
      }

      // Wall-recoil guard: block residual upward momentum that arrives after the
      // spring settles to prevent a second spring from firing.
      if (this.wallRecoilGuardTimer !== null && e.deltaY < 0 && this.isAtResultsTop()) {
        e.preventDefault();
        // Count guarded upward pushes toward deliberate escape so a longer
        // recoil guard doesn't make the results wall feel artificially sticky.
        this.accumulated += e.deltaY;
        if (this.accumulated < -WHEEL_RESULTS_ESCAPE_THRESHOLD) {
          this.accumulated = 0;
          this.snapTo(1);
          return;
        }
        this.armWallRecoilGuard();
        return;
      }

      // At the top boundary, scrolling up: accumulate for escape detection,
      // then let native scroll carry the page past the wall — handleScroll
      // springs it back, identical to the iOS momentum-scroll path.
      if (this.isAtResultsTop() && e.deltaY < 0) {
        this.accumulated += e.deltaY; // grows more negative with each push
        if (this.accumulated < -WHEEL_RESULTS_ESCAPE_THRESHOLD) {
          // Deliberate sustained escape: preventDefault to stop native scroll
          // then snap cleanly to ingest.
          e.preventDefault();
          this.accumulated = 0;
          this.snapTo(1);
          return;
        }
        // No preventDefault → native scroll moves the page past the wall →
        // handleScroll fires the spring, same as iOS finger-lift inertia.
        return;
      }

      // Scrolling into results (not at top, or downward): native scroll.
      // Reset stale wall-contact accumulation so the next upward push
      // starts fresh rather than counting toward an old escape gesture.
      if (e.deltaY > 0) this.accumulated = 0;
      return;
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

  // Called by wheel handler for panes 0 and 1 only.
  private trySnap(delta: number): void {
    if (this.cooldown) return;
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
