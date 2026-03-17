// apps/web/src/SnapNav.tsx
import './SnapNav.css';

interface SnapNavProps {
  currentPane: number;
  onSnap: (pane: number) => void;
}

const PANE_COUNT = 3;

export function SnapNav({ currentPane, onSnap }: SnapNavProps) {
  const isDark = currentPane === 0;

  return (
    <nav
      className={`snap-nav snap-nav--${isDark ? 'dark' : 'light'}`}
      aria-label="Section navigation"
    >
      <button
        className={`snap-nav__arrow${currentPane === 0 ? ' snap-nav__arrow--disabled' : ''}`}
        onClick={() => onSnap(currentPane - 1)}
        aria-label="Previous section"
        disabled={currentPane === 0}
      >
        ▲
      </button>

      {Array.from({ length: PANE_COUNT }, (_, i) => (
        <button
          key={i}
          className={`snap-nav__pip snap-nav__pip--${i === currentPane ? 'active' : 'inactive'}`}
          onClick={() => onSnap(i)}
          aria-label={`Go to section ${i + 1}`}
        />
      ))}

      <button
        className={`snap-nav__arrow${currentPane === PANE_COUNT - 1 ? ' snap-nav__arrow--disabled' : ''}`}
        onClick={() => onSnap(currentPane + 1)}
        aria-label="Next section"
        disabled={currentPane === PANE_COUNT - 1}
      >
        ▼
      </button>
    </nav>
  );
}
