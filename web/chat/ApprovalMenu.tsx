import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ApprovalMode } from "./types";
import { Check, Hand } from "./icons";
import "./approval.css";

/*
 * The composer's approval chip + popover ("How should actions be approved?").
 * Keyboard: Enter/Space/Arrow opens, Up/Down/Home/End move, Enter/Space picks, Esc closes and returns focus to the chip.
 * Choosing Full access asks once (remembered in localStorage) before it takes effect.
 */

const ACK_KEY = "minimi.fullAccessAck";
const LEARN_MORE = "https://github.com/KiranTejz20005/minimi#approvals";

const Svg = ({ children }: { children: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);
const ShieldCheck = () => (
  <Svg>
    <path d="M8 1.8 2.9 3.6v3.9c0 3 2.1 5.2 5.1 6.7 3-1.5 5.1-3.7 5.1-6.7V3.6z" />
    <path d="m5.8 8 1.7 1.7L10.4 6.6" />
  </Svg>
);
const ShieldWarn = () => (
  <Svg>
    <path d="M8 1.8 2.9 3.6v3.9c0 3 2.1 5.2 5.1 6.7 3-1.5 5.1-3.7 5.1-6.7V3.6z" />
    <path d="M8 5.6v3M8 10.9v.1" />
  </Svg>
);

export const APPROVAL_MODES: { id: ApprovalMode; chip: string; title: string; desc: string; icon: ReactNode }[] = [
  { id: "request", chip: "Request approval", title: "Request approval", desc: "Always ask before editing outside files or using the internet", icon: <Hand /> },
  { id: "auto", chip: "Approve for me", title: "Approve for me", desc: "Only ask for potentially unsafe actions", icon: <ShieldCheck /> },
  { id: "full", chip: "Full access", title: "Full access", desc: "Unrestricted access to the internet and all files on your computer", icon: <ShieldWarn /> },
];

const acked = () => {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
};

export function ApprovalMenu({ mode, onChange }: { mode: ApprovalMode; onChange: (m: ApprovalMode) => void }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = APPROVAL_MODES.find((m) => m.id === mode) ?? APPROVAL_MODES[1]!;

  const items = () => Array.from(root.current?.querySelectorAll<HTMLElement>("[data-apv-item]") ?? []);
  const focusItem = (i: number) => {
    const list = items();
    list[(i + list.length) % list.length]?.focus();
  };

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setConfirming(false);
    if (returnFocus) trigger.current?.focus();
  }, []);

  // Fixed, anchored above the chip: the home screen scrolls, and a scroller would clip an absolutely placed menu.
  const [pos, setPos] = useState<{ left: number; bottom: number; maxH: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(420, window.innerWidth - 32);
      setPos({ left: Math.max(16, Math.min(r.left - 4, window.innerWidth - width - 16)), bottom: window.innerHeight - r.top + 10, maxH: Math.max(160, r.top - 24) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Dismiss on an outside press; focus moves into the menu when it opens (selected row first).
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open, close]);
  useEffect(() => {
    if (!open) return;
    const t = window.requestAnimationFrame(() => {
      const list = items();
      (list.find((e) => e.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
    });
    return () => window.cancelAnimationFrame(t);
  }, [open]);
  useEffect(() => {
    if (confirming) window.requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-apv-cancel]")?.focus());
  }, [confirming]);

  const pick = (m: ApprovalMode) => {
    if (m === "full" && mode !== "full" && !acked()) {
      setConfirming(true);
      return;
    }
    onChange(m);
    close();
  };
  const confirmFull = () => {
    try {
      localStorage.setItem(ACK_KEY, "1");
    } catch {
      /* storage unavailable: the confirm just shows again next time */
    }
    onChange("full");
    close();
  };

  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (confirming) setConfirming(false);
      else close();
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (confirming) return;
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") (e.preventDefault(), focusItem(at + 1));
    else if (e.key === "ArrowUp") (e.preventDefault(), focusItem(at - 1));
    else if (e.key === "Home") (e.preventDefault(), focusItem(0));
    else if (e.key === "End") (e.preventDefault(), focusItem(list.length - 1));
  };

  return (
    <div className="apv" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="cp__toggle apv__chip"
        data-mode={mode}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="How should actions be approved?"
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={onTriggerKey}
      >
        {current.icon}
        {current.chip}
      </button>

      <div id={menuId} className="apv__menu" role="menu" aria-label="How should actions be approved?" data-open={open || undefined} inert={!open} onKeyDown={onMenuKey} style={pos ? { left: pos.left, bottom: pos.bottom, maxHeight: pos.maxH } : undefined}>
        {confirming ? (
          <div className="apv__confirm" role="alertdialog" aria-labelledby={`${menuId}-t`} aria-describedby={`${menuId}-d`}>
            <p id={`${menuId}-t`} className="apv__ctitle">
              <ShieldWarn /> Turn on Full access?
            </p>
            <p id={`${menuId}-d`} className="apv__cdesc">Minimi will search the web and open pages without asking you first. You can switch back at any time.</p>
            <div className="apv__cactions">
              <button type="button" data-apv-cancel className="apv__btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="apv__btn apv__btn--warn" onClick={confirmFull}>
                Turn on
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="apv__head">
              <span>How should actions be approved?</span>
              <a href={LEARN_MORE} target="_blank" rel="noopener noreferrer">
                Learn more
              </a>
            </div>
            {APPROVAL_MODES.map((m) => (
              <button key={m.id} type="button" role="menuitemradio" aria-checked={mode === m.id} data-apv-item data-tone={m.id === "full" ? "warn" : undefined} className="apv__item" onClick={() => pick(m.id)}>
                <span className="apv__icon">{m.icon}</span>
                <span className="apv__text">
                  <strong>{m.title}</strong>
                  <small>{m.desc}</small>
                </span>
                <span className="apv__check">{mode === m.id && <Check size={14} />}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
