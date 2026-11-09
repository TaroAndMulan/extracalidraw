const icon = (path: React.ReactNode, viewBox = "0 0 24 24") => (
  <svg
    viewBox={viewBox}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
);

export const pagesIcon = icon(
  <>
    <path d="M8 4h9a2 2 0 0 1 2 2v12" />
    <rect x="4" y="7" width="12" height="14" rx="2" />
  </>,
);

export const backIcon = icon(
  <>
    <path d="M5 12h14" />
    <path d="M5 12l6 6" />
    <path d="M5 12l6-6" />
  </>,
);

export const printIcon = icon(
  <>
    <path d="M17 17h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2" />
    <path d="M17 9V5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v4" />
    <rect x="7" y="13" width="10" height="8" rx="2" />
  </>,
);

export const chevronLeft = icon(<path d="M15 6l-6 6l6 6" />);
export const chevronRight = icon(<path d="M9 6l6 6l-6 6" />);
export const plusIcon = icon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

export const magnetIcon = icon(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
  </>,
);

export const lockIcon = icon(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
);

export const unlockIcon = icon(
  <>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 7.5-2" />
  </>,
);

export const shareIcon = icon(
  <>
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="18" cy="18" r="3" />
    <path d="M8.7 10.7l6.6-3.4M8.7 13.3l6.6 3.4" />
  </>,
);

export const presentIcon = icon(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M12 16v4M8 20h8" />
    <path d="M10 8l4 2l-4 2z" />
  </>,
);

export const highlighterIcon = icon(
  <>
    <path d="M3 19h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4" />
    <path d="M12.5 5.5l4 4" />
    <path d="M4.5 13.5l4 4" />
    <path d="M21 15v4h-8l4 -4z" />
  </>,
);

export const eraserIcon = icon(
  <>
    <path d="M19 20h-10.5l-4.21 -4.3a1 1 0 0 1 0 -1.41l10 -10a1 1 0 0 1 1.41 0l5 5a1 1 0 0 1 0 1.41l-9.2 9.3" />
    <path d="M18 13.3l-6.3 -6.3" />
  </>,
);

/** a finger: "fingers draw" (pen mode off) */
export const fingerIcon = icon(
  <>
    <path d="M8 13v-8.5a1.5 1.5 0 0 1 3 0v7.5" />
    <path d="M11 11.5v-2a1.5 1.5 0 1 1 3 0v2.5" />
    <path d="M14 10.5a1.5 1.5 0 0 1 3 0v1.5" />
    <path d="M17 11.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.47 1.47" />
  </>,
);

export const fullscreenIcon = icon(
  <>
    <path d="M4 8v-2a2 2 0 0 1 2 -2h2" />
    <path d="M4 16v2a2 2 0 0 0 2 2h2" />
    <path d="M16 4h2a2 2 0 0 1 2 2v2" />
    <path d="M16 20h2a2 2 0 0 0 2 -2v-2" />
  </>,
);

export const viewIcon = icon(
  <>
    <path d="M2.5 12s3.5-6.5 9.5-6.5s9.5 6.5 9.5 6.5s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.75" />
  </>,
);

/** two screens showing the same thing */
export const togetherIcon = icon(
  <>
    <rect x="2.5" y="4.5" width="12" height="9" rx="1.5" />
    <rect x="9.5" y="10.5" width="12" height="9" rx="1.5" />
  </>,
);

export const returnIcon = icon(
  <>
    <path d="M9 14l-4-4l4-4" />
    <path d="M5 10h10a4.5 4.5 0 0 1 0 9h-2" />
  </>,
);

/** a window with its left panel, and which way the panel will go */
const panelLeft = (arrow: string) =>
  icon(
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9.5 4v16" />
      <path d={arrow} />
    </>,
  );
/** the style panel is out: tap to tuck it away */
export const panelLeftCloseIcon = panelLeft("M16 9.5l-2.5 2.5l2.5 2.5");
/** the style panel is tucked away: tap to bring it back */
export const panelLeftOpenIcon = panelLeft("M13.5 9.5l2.5 2.5l-2.5 2.5");
