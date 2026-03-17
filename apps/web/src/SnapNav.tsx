// apps/web/src/SnapNav.tsx
import { useEffect, useRef, useState } from 'react';
import './SnapNav.css';

interface SnapNavProps {
  currentPane: number;
  onSnap: (pane: 0 | 1 | 2) => void;
}

const PANE_COUNT = 3;
const PROXIMITY_PX = 80;  // reveal when mouse is within this many px of left edge
const HIDE_DELAY_MS = 1500;

export function SnapNav({ currentPane, onSnap }: SnapNavProps) {
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDark = currentPane === 0;

  const scheduleHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  };

  const reveal = () => {
    setVisible(true);
    scheduleHide();
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (e.clientX < PROXIMITY_PX) reveal();
    };
    const onWheel = () => reveal();

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('wheel', onWheel);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  return (
    <nav
      className={`snap-nav snap-nav--${isDark ? 'dark' : 'light'}${visible ? ' snap-nav--visible' : ''}`}
      aria-label="Section navigation"
      onMouseEnter={() => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        setVisible(true);
      }}
      onMouseLeave={scheduleHide}
    >
      <button
        className={`snap-nav__arrow${currentPane === 0 ? ' snap-nav__arrow--disabled' : ''}`}
        onClick={() => onSnap((currentPane - 1) as 0 | 1 | 2)}
        aria-label="Previous section"
        disabled={currentPane === 0}
      >
        ▲
      </button>

      {Array.from({ length: PANE_COUNT }, (_, i) => (
        <button
          key={i}
          className={`snap-nav__pip snap-nav__pip--${i === currentPane ? 'active' : 'inactive'}`}
          onClick={() => onSnap(i as 0 | 1 | 2)}
          aria-label={`Go to section ${i + 1}`}
          aria-current={i === currentPane ? 'step' : undefined}
        />
      ))}

      <button
        className={`snap-nav__arrow${currentPane === PANE_COUNT - 1 ? ' snap-nav__arrow--disabled' : ''}`}
        onClick={() => onSnap((currentPane + 1) as 0 | 1 | 2)}
        aria-label="Next section"
        disabled={currentPane === PANE_COUNT - 1}
      >
        ▼
      </button>
    </nav>
  );
}
