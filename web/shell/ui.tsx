import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DropdownMenu, type DropdownMenuItem } from "./DropdownMenu";

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

/* ── Menu: anchored DropdownMenu for context menus and legacy callers ── */
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

function toDropdownItems(items: MenuItem[]): DropdownMenuItem[] {
  const out: DropdownMenuItem[] = [];
  let pendingDivider = false;
  for (const it of items) {
    if (it.separator) {
      pendingDivider = true;
      continue;
    }
    if (it.heading) {
      // Skip non-interactive headings; keep a divider so the following group stays separated
      pendingDivider = true;
      continue;
    }
    out.push({
      label: it.label ?? "",
      icon: it.icon,
      danger: it.danger,
      checked: it.checked,
      type: it.checked !== undefined ? "radio" : undefined,
      shortcut: it.hint,
      divider: pendingDivider || undefined,
      onSelect: it.onSelect,
      submenu: it.submenu ? toDropdownItems(it.submenu) : undefined,
    });
    pendingDivider = false;
  }
  return out;
}

export function Menu({
  anchor,
  items,
  onClose,
  width = 216,
  align = "start",
  label,
  header,
  side,
}: {
  anchor: MenuAnchor;
  items: MenuItem[];
  onClose: () => void;
  width?: number;
  align?: "start" | "end";
  label?: string;
  /** Content above the items (e.g. who is signed in) */
  header?: ReactNode;
  /** Preferred side to open on; flips when there is no room */
  side?: "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const focusEl = useRef(anchor.el);
  focusEl.current = anchor.el;

  // Open after mount so DropdownMenu treats this as a closed→open transition and focuses the first item
  useEffect(() => {
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => closeRef.current();
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  const r = anchor.rect;
  const w = Math.max(r.width, 1);
  const h = Math.max(r.height, 1);

  const finishClose = () => {
    closeRef.current();
    const el = focusEl.current;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      className="ui-dmc-anchor"
      style={{
        position: "fixed",
        left: r.left,
        top: r.top,
        width: w,
        height: h,
        zIndex: 1000,
      }}
    >
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) finishClose();
        }}
        items={toDropdownItems(items)}
        width={width}
        align={align}
        side={side}
        header={header}
        aria-label={label}
        className="ui-dmc-anchor__menu"
        /* Non-focusable hit target: avoids trapping focus on an aria-hidden phantom button (esp. context menus) */
        trigger={() => <span aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />}
      />
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
