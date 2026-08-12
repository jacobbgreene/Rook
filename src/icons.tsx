// Shared SVG icon set — extracted from App.tsx.

const iconProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const SkipBackIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M19 20L9 12l10-8V20z" />
    <line x1="5" y1="4" x2="5" y2="20" />
  </svg>
);

export const BackIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

export const ForwardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

export const SkipForwardIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M5 4l10 8-10 8V4z" />
    <line x1="19" y1="4" x2="19" y2="20" />
  </svg>
);

export const FlipIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <polyline points="17 1 21 5 17 9"></polyline>
    <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
    <polyline points="7 23 3 19 7 15"></polyline>
    <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
  </svg>
);

export const ResetIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

export const CoachIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" {...iconProps}>
    <path d="M12 2a10 10 0 1 0 10 10H12V2z" />
    <path d="M12 12L2.1 10.05" />
    <path d="M12 12l1.21-9.81" />
    <path d="M12 12l8.76-4.81" />
    <path d="M12 12l5.88 8.09" />
    <path d="M12 12l-9.46 3.25" />
  </svg>
);

export const ReportIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

export const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const EyeOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

export const ImportIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...iconProps}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const SettingsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const HelpIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...iconProps}>
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="5" r="1.7" />
    <circle cx="12" cy="12" r="1.7" />
    <circle cx="12" cy="19" r="1.7" />
  </svg>
);
