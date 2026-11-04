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
