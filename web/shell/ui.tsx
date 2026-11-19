import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronLeft, IconChevronRight } from "./icons";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/* ── Dialog: focus trap, Esc, backdrop click, focus return ── */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2, 8)}`).current;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>("[data-autofocus]") ?? node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const a = items[0]!;
      const z = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${className ?? ""}`}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close dialog" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      width={400}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy} data-autofocus>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="dialog-msg">{message}</p>
    </Dialog>
  );
}

/* ── Menu: portal, viewport-clamped, keyboard navigable, optional one-level submenu ── */
export type MenuItem = {
  key: string;
  label?: string;
  icon?: ReactNode;
  danger?: boolean;
  checked?: boolean;
  separator?: boolean;
  heading?: boolean;
  hint?: string;
  onSelect?: () => void;
  submenu?: MenuItem[];
};
export type MenuAnchor = { rect: DOMRect; el?: HTMLElement | null };

export function anchorFromEvent(e: { currentTarget: EventTarget | null }): MenuAnchor {
  const el = e.currentTarget as HTMLElement;
  return { rect: el.getBoundingClientRect(), el };
}
export function anchorFromPoint(x: number, y: number): MenuAnchor {
  return { rect: new DOMRect(x, y, 0, 0) };
}

export function Menu({
  anchor,
  items,
  onClose,
  width = 216,
  align = "start",
  label,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  width?: number;
  align?: "start" | "end";
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<{ title: string; items: MenuItem[] }[]>([]);
  const [pos, setPos] = useState<{ left: number; top: number; origin: string } | null>(null);
  const current = stack.length ? stack[stack.length - 1]!.items : items;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const close = useCallback(() => {
    closeRef.current();
    const el = anchor.el;
    if (el && document.contains(el)) el.focus();
  }, [anchor.el]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const h = node.offsetHeight;
    const r = anchor.rect;
    const M = 8;
    let left = align === "end" ? r.right - width : r.left;
    left = Math.max(M, Math.min(left, window.innerWidth - width - M));
    let top = r.bottom + 4;
    let origin = `${align === "end" ? "right" : "left"} top`;
    if (top + h > window.innerHeight - M) {
      const above = r.top - h - 4;
      if (above >= M) {
        top = above;
        origin = origin.replace("top", "bottom");
      } else {
        top = Math.max(M, window.innerHeight - h - M);
      }
    }
    setPos({ left, top, origin });
  }, [anchor, width, align, current]);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role^="menuitem"]');
    first?.focus();
  }, [stack.length]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const blur = () => closeRef.current();
    document.addEventListener("mousedown", down, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, []);

  const onKey = (e: RKeyboardEvent) => {
    const els = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      els[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      els[els.length - 1]?.focus();
    } else if (e.key === "ArrowLeft" && stack.length) {
      e.preventDefault();
      setStack((s) => s.slice(0, -1));
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  const select = (it: MenuItem) => {
    if (it.submenu) {
      setStack((s) => [...s, { title: it.label ?? "", items: it.submenu! }]);
      return;
    }
    closeRef.current();
    const el = anchor.el;
    if (el && document.contains(el)) el.focus();
    it.onSelect?.();
  };

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      aria-label={label}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width,
        visibility: pos ? "visible" : "hidden",
        transformOrigin: pos?.origin,
      }}
      onKeyDown={onKey}
    >
      {stack.length > 0 && (
        <button type="button" role="menuitem" className="menu-item menu-back" onClick={() => setStack((s) => s.slice(0, -1))}>
          <IconChevronLeft size={14} />
          <span>{stack[stack.length - 1]!.title}</span>
        </button>
      )}
      {current.map((it) =>
        it.separator ? (
          <div key={it.key} className="menu-sep" role="separator" />
        ) : it.heading ? (
          <div key={it.key} className="menu-heading">
            {it.label}
          </div>
        ) : (
          <button
            key={it.key}
            type="button"
            role={it.checked !== undefined ? "menuitemradio" : "menuitem"}
            aria-checked={it.checked}
            className={`menu-item ${it.danger ? "danger" : ""}`}
            onClick={() => select(it)}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.checked && <IconCheck size={14} />}
            {it.hint && <kbd className="kbd">{it.hint}</kbd>}
            {it.submenu && <IconChevronRight size={14} />}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/* ── Small pieces ── */
export function Avatar({ text, size = 22, tone }: { text: string; size?: number; tone?: "accent" | "neutral" }) {
  return (
    <span className="avatar" data-tone={tone ?? "neutral"} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {text}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" role="status" aria-label="Loading" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <p className="empty-title">{title}</p>
      {children && <p className="empty-sub">{children}</p>}
    </div>
  );
}
