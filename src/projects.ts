/** Folder (project) colors. The UI mirrors this list in web/shell/icons.tsx (FOLDER_COLORS). */
export const PROJECT_COLORS = ["blue", "sky", "green", "amber", "orange", "red", "pink", "purple", "gray"] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];
export const DEFAULT_PROJECT_COLOR: ProjectColor = "blue";

/** The color if `v` is one of the palette names (case-insensitive, trimmed), otherwise null. */
export function parseProjectColor(v: unknown): ProjectColor | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (PROJECT_COLORS as readonly string[]).includes(s) ? (s as ProjectColor) : null;
}

/** Like parseProjectColor, but unknown, missing or legacy NULL values fall back to the default blue. */
export function normalizeProjectColor(v: unknown): ProjectColor {
  return parseProjectColor(v) ?? DEFAULT_PROJECT_COLOR;
}
