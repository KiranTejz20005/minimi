import type { ReactNode } from "react";

const Svg = ({ children, size = 16, fill }: { children: ReactNode; size?: number; fill?: boolean }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill={fill ? "currentColor" : "none"}
    stroke={fill ? "none" : "currentColor"}
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
);

export const Globe = () => (
  <Svg>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c1.8 1.8 2.6 3.8 2.6 6S9.8 12.2 8 14M8 2C6.2 3.8 5.4 5.8 5.4 8S6.2 12.2 8 14" />
  </Svg>
);
export const Page = () => (
  <Svg>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M9 2.5v3h3M6 8.5h4M6 11h4" />
  </Svg>
);
export const Calc = () => (
  <Svg>
    <rect x="3.5" y="2" width="9" height="12" rx="1.5" />
    <path d="M5.5 4.8h5M6 8h.01M8 8h.01M10 8h.01M6 10.5h.01M8 10.5h.01M10 10.5h.01" />
  </Svg>
);
export const Bookmark = () => (
  <Svg>
    <path d="M4.5 2.5h7v11L8 11l-3.5 2.5z" />
  </Svg>
);
export const Wrench = () => (
  <Svg>
    <path d="M10.5 2.5a3 3 0 0 0-2.7 4.1L2.8 11.6a1.4 1.4 0 0 0 2 2l5-5a3 3 0 0 0 4.1-2.7l-1.9 1.9-1.6-.4-.4-1.6z" />
  </Svg>
);
export const Stop = () => (
  <Svg>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M6 6l4 4" />
  </Svg>
);
export const Memory = () => (
  <Svg>
    <path d="M8 2.5a5.5 5.5 0 1 0 5.2 7.3" />
    <path d="M8 5v3.2l2 1.3M11 2.5h2.5V5" />
  </Svg>
);
export const Chevron = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </Svg>
);
export const Plus = () => (
  <Svg>
    <path d="M8 3.5v9M3.5 8h9" />
  </Svg>
);
export const Hand = () => (
  <Svg>
    <path d="M5.5 8.5V3.8a1 1 0 0 1 2 0V7m0-3.6a1 1 0 0 1 2 0V7m0-2.3a1 1 0 0 1 2 0V9.3c0 2.4-1.5 4.2-3.8 4.2-1.5 0-2.4-.7-3.3-1.9L2.8 9.3a1 1 0 0 1 1.6-1.2l1.1 1.4" />
  </Svg>
);
export const Mic = () => (
  <Svg>
    <rect x="6" y="2" width="4" height="7.5" rx="2" />
    <path d="M3.8 7.8a4.2 4.2 0 0 0 8.4 0M8 12v2" />
  </Svg>
);
export const ArrowUp = () => (
  <Svg>
    <path d="M8 13V3.5M4 7.2 8 3.2l4 4" />
  </Svg>
);
export const StopSquare = () => (
  <Svg fill>
    <rect x="4" y="4" width="8" height="8" rx="1.8" />
  </Svg>
);
export const Paperclip = () => (
  <Svg>
    <path d="m11.8 7.5-4.3 4.3a2.6 2.6 0 0 1-3.7-3.7l5-5a1.7 1.7 0 0 1 2.4 2.4l-5 5a.8.8 0 0 1-1.2-1.2L9.6 5" />
  </Svg>
);
export const Check = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);
export const Close = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <path d="m4 4 8 8m0-8-8 8" />
  </Svg>
);
export const PanelRight = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M10 3v10" />
  </Svg>
);
export const Download = () => (
  <Svg>
    <path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 13h10" />
  </Svg>
);
export const Copy = () => (
  <Svg>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
    <path d="M10.5 5.5v-1A1.5 1.5 0 0 0 9 3H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1" />
  </Svg>
);
export const FileIcon = () => (
  <Svg>
    <path d="M4 2.5h5l3 3v8H4z" />
    <path d="M9 2.5v3h3" />
  </Svg>
);
export const LinkOut = () => (
  <Svg>
    <path d="M6.5 3.5h-2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-2M9 3h4v4M13 3 7.5 8.5" />
  </Svg>
);
export const Plug = () => (
  <Svg>
    <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0zM8 11.2v2.3" />
  </Svg>
);
export const Spark = () => (
  <Svg>
    <path d="M8 2.5 9.4 6.6l4.1 1.4-4.1 1.4L8 13.5 6.6 9.4 2.5 8l4.1-1.4z" />
  </Svg>
);
export const Spinner = ({ size = 14 }: { size?: number }) => (
  <svg className="cm-spin" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.8" />
    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
export const ArrowDown = () => (
  <Svg>
    <path d="M8 3v9.5M4 8.8l4 4 4-4" />
  </Svg>
);
