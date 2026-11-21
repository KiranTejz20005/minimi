import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/* Building blocks shared by every Settings page. Styles live in ../settings.css (st-*). */

/* ── Icons (14px, 1.5 stroke) ── */
const P: Record<string, ReactNode> = {
  user: <><circle cx="8" cy="5.5" r="2.5" /><path d="M3 13.5c.4-2.4 2.3-3.8 5-3.8s4.6 1.4 5 3.8" /></>,
  sliders: <><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" /><circle cx="10" cy="4.5" r="1.5" /><circle cx="6" cy="11.5" r="1.5" /></>,
  bell: <><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3L4 11Z" /><path d="M6.5 14h3" /></>,
  shield: <path d="M8 2 3 4v3.6c0 3 2 5 5 6.4 3-1.4 5-3.4 5-6.4V4L8 2Z" />,
  cog: <><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></>,
  users: <><circle cx="6" cy="5.5" r="2.2" /><path d="M2 13c.3-2.2 1.9-3.4 4-3.4s3.7 1.2 4 3.4" /><path d="M10.5 3.6a2.2 2.2 0 0 1 0 3.8M12 9.8c1.2.4 2 1.4 2.2 3.2" /></>,
  cube: <><path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5L8 1.8Z" /><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6" /></>,
  lock: <><rect x="3" y="7" width="10" height="6.5" rx="1.6" /><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" /></>,
  card: <><rect x="1.8" y="3.5" width="12.4" height="9" rx="1.8" /><path d="M1.8 6.6h12.4M4 10h2.4" /></>,
  search: <><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></>,
  chevL: <path d="m9.5 3.5-4.5 4.5 4.5 4.5" />,
  chevD: <path d="m4 6.2 4 4 4-4" />,
  upload: <><path d="M8 10.5V2.8M5 5.6 8 2.6l3 3" /><path d="M2.8 10.5v2.2h10.4v-2.2" /></>,
  expand: <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />,
  info: <><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.4M8 5.2v.1" /></>,
  globe: <><circle cx="8" cy="8" r="5.8" /><path d="M2.2 8h11.6M8 2.2c1.8 1.7 2.7 3.6 2.7 5.8s-.9 4.1-2.7 5.8C6.2 12.1 5.3 10.2 5.3 8S6.2 3.9 8 2.2Z" /></>,
  monitor: <><rect x="2" y="2.8" width="12" height="8" rx="1.6" /><path d="M6 13.5h4M8 10.8v2.7" /></>,
  sun: <><circle cx="8" cy="8" r="2.6" /><path d="M8 1.8v1.4M8 12.8v1.4M1.8 8h1.4M12.8 8h1.4M3.6 3.6l1 1M11.4 11.4l1 1M3.6 12.4l1-1M11.4 4.6l1-1" /></>,
  moon: <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />,
  memory: <><path d="M5.5 3.5a2.5 2.5 0 0 0-2.4 3 2.4 2.4 0 0 0 .6 4.5A2.5 2.5 0 0 0 8 12.3V4.2A2.2 2.2 0 0 0 5.5 3.5Z" /><path d="M10.5 3.5a2.5 2.5 0 0 1 2.4 3 2.4 2.4 0 0 1-.6 4.5A2.5 2.5 0 0 1 8 12.3" /></>,
  laptop: <><rect x="3" y="3.5" width="10" height="7" rx="1.2" /><path d="M1.8 12.5h12.4" /></>,
  trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8" /></>,
  check: <path d="m3.5 8.5 3 3 6-7" />,
};

export function Ic({ n, size = 14 }: { n: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="st-ic">
      {P[n]}
    </svg>
  );
}

/* ── Layout ── */
export function Head({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <header className="st-head">
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </header>
  );
}

export function H2({ children, sub, danger }: { children: ReactNode; sub?: ReactNode; danger?: boolean }) {
  return (
    <div className="st-h2wrap">
      <h2 className="st-h2" data-danger={danger || undefined}>{children}</h2>
      {sub && <p className="st-h2sub">{sub}</p>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={["st-card", className].filter(Boolean).join(" ")}>{children}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="st-notice" role="note">
      <Ic n="info" />
      <span>{children}</span>
    </div>
  );
}

export function Row({ title, desc, children, icon }: { title: ReactNode; desc?: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="st-row">
      {icon && <span className="st-rowicon">{icon}</span>}
      <div className="st-rowtext">
        <strong>{title}</strong>
        {desc && <small>{desc}</small>}
      </div>
      {children && <div className="st-ctl">{children}</div>}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "green" | "neutral" | "amber" }) {
  return <span className="st-badge" data-tone={tone ?? "neutral"}>{children}</span>;
}

export function Btn({ children, variant, ...rest }: { children: ReactNode; variant?: "primary" | "danger" | "ghost" } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={["st-btn", rest.className].filter(Boolean).join(" ")} data-variant={variant}>
      {children}
    </button>
  );
}

/* ── Controls ── */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="st-switch" onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export type Opt = { value: string; label: string; disabled?: boolean };

/** A native select (keyboard + screen-reader friendly) dressed like the reference: icon, label, chevron. */
export function Select({ value, onChange, options, label, icon, width, disabled, placeholder }: { value: string; onChange: (v: string) => void; options: Opt[]; label: string; icon?: ReactNode; width?: number; disabled?: boolean; placeholder?: string }) {
  const empty = !options.some((o) => o.value === value);
  return (
    <label className="st-select" data-disabled={disabled || undefined} data-empty={empty || undefined} style={width ? { width } : undefined}>
      {icon && <span className="st-selicon">{icon}</span>}
      <span className="st-selvalue">{empty ? (placeholder ?? "Choose…") : options.find((o) => o.value === value)?.label}</span>
      <select value={empty ? "" : value} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value)}>
        {empty && <option value="" disabled>{placeholder ?? "Choose…"}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      <Ic n="chevD" size={12} />
    </label>
  );
}

export function Seg<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[]; label: string }) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Text input that saves when you leave it or press Enter (no Save button), and reverts on Escape. */
export function TextInput({ value, onCommit, label, placeholder, maxLength, type = "text", width }: { value: string; onCommit: (v: string) => void | Promise<unknown>; label: string; placeholder?: string; maxLength?: number; type?: string; width?: number }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) void onCommit(draft);
  };
  return (
    <input
      className="st-input"
      type={type}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      maxLength={maxLength}
      style={width ? { width } : undefined}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Textarea with a live counter and an expand toggle; saves on blur. */
export function TextArea({ value, onCommit, label, placeholder, max, rows = 4 }: { value: string; onCommit: (v: string) => void | Promise<unknown>; label: string; placeholder?: string; max: number; rows?: number }) {
  const [draft, setDraft] = useState(value);
  const [big, setBig] = useState(false);
  const id = useId();
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="st-areawrap">
      <div className="st-area" data-big={big || undefined}>
        <textarea
          id={id}
          value={draft}
          aria-label={label}
          placeholder={placeholder}
          maxLength={max}
          rows={big ? rows * 2 + 2 : rows}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft.trim() !== value && void onCommit(draft)}
        />
        <button type="button" className="st-expand" aria-label={big ? "Collapse" : "Expand"} aria-pressed={big} onClick={() => setBig((b) => !b)}>
          <Ic n="expand" size={13} />
        </button>
      </div>
      <span className="st-count" aria-live="polite">{draft.length.toLocaleString("en")}/{max.toLocaleString("en")}</span>
    </div>
  );
}

/** Square tile with a checkbox in the corner (Chat tools). */
export function ToolTile({ icon, title, desc, checked, onChange }: { icon: ReactNode; title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="st-tile" onClick={() => onChange(!checked)}>
      <span className="st-tilehead">
        <span className="st-tileicon">{icon}</span>
        <span className="st-tilebox" aria-hidden="true"><Ic n="check" size={11} /></span>
      </span>
      <strong>{title}</strong>
      <small>{desc}</small>
    </button>
  );
}

/** Picks a small image and returns it as a data URL (stored locally, never uploaded). */
export function ImagePick({ onPick, onError, accept = "image/png,image/jpeg,image/gif,image/webp", maxBytes = 512 * 1024, children }: { onPick: (dataUrl: string) => void; onError: (msg: string) => void; accept?: string; maxBytes?: number; children: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (!accept.split(",").includes(f.type)) return onError("Use a PNG, JPEG, GIF or WebP image.");
          if (f.size > maxBytes) return onError(`That image is too big (max ${Math.round(maxBytes / 1024)} KB).`);
          const r = new FileReader();
          r.onload = () => typeof r.result === "string" && onPick(r.result);
          r.onerror = () => onError("Couldn't read that file.");
          r.readAsDataURL(f);
        }}
      />
      <span onClick={() => ref.current?.click()}>{children}</span>
    </>
  );
}

/** "Edge on Windows" from a user-agent string. Pure. */
export function describeDevice(ua: string): { browser: string; os: string } {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "this device";
  return { browser, os };
}
