// apps/web/src/SnapNav.tsx
import { useEffect, useState } from 'react';
import './SnapNav.css';

interface SnapNavProps {
  currentPane: number;
  onSnap: (pane: 0 | 1 | 2) => void;
}

const PANE_COUNT = 3;

// How long the smooth scroll animation takes (must cover the longest jump).
// Switching to dark theme before the scroll reaches pane 0 makes white pills
// invisible against a light background. Delay the dark flip until we're there.
const SCROLL_ANIM_MS = 500;

export function SnapNav({ currentPane, onSnap }: SnapNavProps) {
  const [isDark, setIsDark] = useState(currentPane === 0);

  useEffect(() => {
    if (currentPane === 0) {
      // Going to the dark hero pane — delay theme flip until scroll has landed.
      const id = setTimeout(() => setIsDark(true), SCROLL_ANIM_MS);
      return () => clearTimeout(id);
    }
    setIsDark(false);
  }, [currentPane]);

  return (
    <nav
      className={`snap-nav snap-nav--${isDark ? 'dark' : 'light'}`}
      aria-label="Section navigation"
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
