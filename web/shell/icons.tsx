import type { ReactElement } from "react";

type IconProps = { size?: number; className?: string };

const make =
  (d: string, strokeWidth = 1.6) =>
  ({ size = 16, className }: IconProps): ReactElement => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );

export const IconPlus = make("M12 5v14M5 12h14");
export const IconSearch = make("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3");
export const IconNewChat = make("M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z");
export const IconChat = make("M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12Z");
export const IconRuns = make("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM10 8.5l5 3.5-5 3.5Z");
export const IconFolder = make("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z");
export const IconChart = make("M4 20V10M10 20V4M16 20v-7M22 20H2");
export const IconPlug = make("M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0ZM12 17v5");
export const IconChevronDown = make("m6 9 6 6 6-6");
export const IconChevronRight = make("m9 6 6 6-6 6");
export const IconChevronLeft = make("m15 6-6 6 6 6");
export const IconSidebar = make("M3 5h18v14H3ZM9 5v14");
export const IconMore = make("M5 12h.01M12 12h.01M19 12h.01", 3);
export const IconPin = make("M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3Z");
export const IconTrash = make("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3");
export const IconCheck = make("m5 12 5 5L20 7", 2);
export const IconX = make("M6 6l12 12M18 6 6 18");
export const IconSun = make(
  "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
);
export const IconMoon = make("M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z");
export const IconMonitor = make("M3 4h18v12H3ZM8 20h8M12 16v4");
export const IconFile = make("M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8ZM14 3v5h5");
export const IconDownload = make("M12 3v12M7 10l5 5 5-5M5 21h14");
export const IconUpload = make("M12 21V9M7 14l5-5 5 5M5 3h14");
export const IconGrid = make("M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z");
export const IconList = make("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01");
export const IconAlert = make(
  "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
);
export const IconClock = make("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2");
export const IconKeyboard = make("M2 6h20v12H2ZM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10");
export const IconExternal = make("M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5");
export const IconBell = make("M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9ZM10.3 21a1.9 1.9 0 0 0 3.4 0");
export const IconEdit = make("M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z");
export const IconGlobe = make("M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18");
export const IconSparkle = make("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7Z");
