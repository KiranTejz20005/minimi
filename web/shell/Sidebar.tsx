import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { Conversation, Project } from "../api";
import type { WorkspaceActions } from "./data";
import {
  IconBell,
  IconChart,
  IconChat,
  IconChevronDown,
  IconChevronRight,
  IconFolder,
  IconKeyboard,
  IconMonitor,
  IconMoon,
  IconMore,
  IconNewChat,
  IconPin,
  IconPlug,
  IconPlus,
  IconRuns,
  IconSearch,
  IconSidebar,
  IconSun,
  IconTrash,
  IconEdit,
  IconClock,
  IconExternal,
  IconSettings,
} from "./icons";
import { Avatar, ConfirmDialog, Menu, anchorFromEvent, anchorFromPoint, type MenuAnchor, type MenuItem } from "./ui";
import { initials, type ThemePref } from "./util";

export type View = "chat" | "runs" | "files" | "analytics" | "settings";
const REPO_URL = "https://github.com/KiranTejz20005/minimi";

export interface SidebarProps {
  conversations: Conversation[];
  projects: Project[];
  loaded: boolean;
  activeChatId?: string;
  view: View;
  collapsed: boolean;
  /** Collapsed because the window is narrow — the toggle is disabled. */
  forcedCollapsed: boolean;
  pendingCount: number;
  userName: string;
  theme: ThemePref;
  newProjectSignal: number;
  onToggleCollapsed: () => void;
  onNewChat: () => void;
  onOpenChat: (id: string) => void;
  onNav: (v: View) => void;
  onOpenPalette: () => void;
  onOpenIntegrations: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onEditName: () => void;
  onSetTheme: (t: ThemePref) => void;
  onOpenClock?: () => void;
  onNewProject: () => void;
  actions: WorkspaceActions;
}

type Editing = { kind: "chat" | "project"; id: string } | null;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";

export function Sidebar(p: SidebarProps) {
  const { conversations, projects, actions } = p;
  const [menu, setMenu] = useState<{ anchor: MenuAnchor; items: MenuItem[]; align?: "start" | "end"; width?: number; label: string; rowId?: string; header?: ReactNode; side?: "top" | "bottom" } | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ kind: "chat" | "project"; id: string; name: string } | null>(null);
  const lastSignal = useRef(p.newProjectSignal);

  useEffect(() => {
    if (p.newProjectSignal !== lastSignal.current) {
      lastSignal.current = p.newProjectSignal;
      setCreating(true);
    }
  }, [p.newProjectSignal]);

  const pinned = useMemo(() => conversations.filter((c) => c.pinned), [conversations]);
  const loose = useMemo(() => conversations.filter((c) => !c.pinned && !c.project_id), [conversations]);
  const byProject = useMemo(() => {
    const m = new Map<string, Conversation[]>();
    for (const c of conversations) if (!c.pinned && c.project_id) m.set(c.project_id, [...(m.get(c.project_id) ?? []), c]);
    return m;
  }, [conversations]);

  // Always show the project that holds the active chat.
  useEffect(() => {
    const active = conversations.find((c) => c.id === p.activeChatId);
    if (active?.project_id && !active.pinned) setExpanded((s) => (s.has(active.project_id!) ? s : new Set(s).add(active.project_id!)));
  }, [p.activeChatId, conversations]);

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /* ── menus ── */
  const chatMenu = (c: Conversation, anchor: MenuAnchor) => {
    const moveItems: MenuItem[] = [
      ...(c.project_id ? [{ key: "none", label: "No project", onSelect: () => void actions.moveChat(c.id, null) }] : []),
      ...projects.map((pr) => ({
        key: pr.id,
        label: pr.name,
        checked: c.project_id === pr.id,
        onSelect: () => void actions.moveChat(c.id, pr.id),
      })),
    ];
    const items: MenuItem[] = [
      { key: "pin", label: c.pinned ? "Unpin" : "Pin", icon: <IconPin />, onSelect: () => void actions.pinChat(c.id, !c.pinned) },
      { key: "rename", label: "Rename", icon: <IconEdit />, onSelect: () => setEditing({ kind: "chat", id: c.id }) },
      ...(projects.length
        ? [{ key: "move", label: "Move to project", icon: <IconFolder />, submenu: moveItems.length ? moveItems : [{ key: "x", heading: true, label: "No projects yet" }] }]
        : []),
      { key: "sep", separator: true },
      { key: "delete", label: "Delete", icon: <IconTrash />, danger: true, onSelect: () => setConfirm({ kind: "chat", id: c.id, name: c.title ?? "this chat" }) },
    ];
    setMenu({ anchor, items, label: `Actions for ${c.title ?? "chat"}`, rowId: c.id, width: 200 });
  };

  const projectMenu = (pr: Project, anchor: MenuAnchor) => {
    setMenu({
      anchor,
      label: `Actions for ${pr.name}`,
      rowId: pr.id,
      width: 190,
      items: [
        { key: "rename", label: "Rename", icon: <IconEdit />, onSelect: () => setEditing({ kind: "project", id: pr.id }) },
        { key: "sep", separator: true },
        { key: "delete", label: "Delete project", icon: <IconTrash />, danger: true, onSelect: () => setConfirm({ kind: "project", id: pr.id, name: pr.name }) },
      ],
    });
  };

  const workspaceMenu = (e: MouseEvent<HTMLButtonElement>) =>
    setMenu({
      anchor: anchorFromEvent(e),
      label: "Workspace",
      width: 220,
      items: [
        { key: "landing", label: "Landing page", icon: <IconMonitor />, onSelect: () => { window.location.href = "/"; } },
        { key: "np", label: "New project", icon: <IconPlus />, onSelect: p.onNewProject },
        { key: "int", label: "Integrations", icon: <IconPlug />, onSelect: p.onOpenIntegrations },
        { key: "sc", label: "Keyboard shortcuts", icon: <IconKeyboard />, onSelect: p.onOpenShortcuts },
        { key: "s1", separator: true },
        { key: "th", heading: true, label: "Theme" },
        ...(["dark", "light", "system"] as ThemePref[]).map((t) => ({
          key: `t-${t}`,
          label: t[0]!.toUpperCase() + t.slice(1),
          icon: t === "dark" ? <IconMoon /> : t === "light" ? <IconSun /> : <IconMonitor />,
          checked: p.theme === t,
          onSelect: () => p.onSetTheme(t),
        })),
      ],
    });

  const userMenu = (e: MouseEvent<HTMLButtonElement>) =>
    setMenu({
      anchor: anchorFromEvent(e),
      label: "Account",
      width: 240,
      side: "top",
      header: (
        <div className="um-head">
          <Avatar text={initials(p.userName)} size={32} tone="accent" />
          <div className="um-head__txt">
            <strong>{p.userName}</strong>
            <small>Local workspace</small>
          </div>
        </div>
      ),
      items: [
        {
          key: "appearance",
          label: "Appearance",
          icon: p.theme === "light" ? <IconSun /> : p.theme === "system" ? <IconMonitor /> : <IconMoon />,
          submenu: (["system", "light", "dark"] as ThemePref[]).map((t) => ({
            key: `t-${t}`,
            label: t[0]!.toUpperCase() + t.slice(1),
            icon: t === "dark" ? <IconMoon /> : t === "light" ? <IconSun /> : <IconMonitor />,
            checked: p.theme === t,
            onSelect: () => p.onSetTheme(t),
          })),
        },
        { key: "int", label: "Integrations", icon: <IconPlug />, onSelect: p.onOpenIntegrations },
        { key: "settings", label: "Settings", icon: <IconSettings />, onSelect: p.onOpenSettings },
        { key: "name", label: "Edit display name…", icon: <IconEdit />, onSelect: p.onEditName },
        { key: "s1", separator: true },
        { key: "sc", label: "Keyboard shortcuts", icon: <IconKeyboard />, onSelect: p.onOpenShortcuts },
        { key: "docs", label: "Learn more", icon: <IconExternal />, onSelect: () => void window.open(REPO_URL, "_blank", "noopener,noreferrer") },
        ...(p.onOpenClock
          ? ([{ key: "s2", separator: true }, { key: "clock", label: "Developer clock…", icon: <IconClock />, onSelect: p.onOpenClock }] as MenuItem[])
          : []),
      ],
    });

  /* ── rows ── */
  const commit = async (kind: "chat" | "project", id: string, value: string, original: string) => {
    setEditing(null);
    const v = value.trim();
    if (!v || v === original) return;
    if (kind === "chat") await actions.renameChat(id, v);
    else await actions.renameProject(id, v);
  };

  const editRow = (kind: "chat" | "project", id: string, original: string) => (
    <EditInput
      key={`${kind}-${id}`}
      original={original}
      max={kind === "chat" ? 120 : 60}
      label={kind === "chat" ? "Chat name" : "Project name"}
      onDone={(value) => (value === null ? setEditing(null) : void commit(kind, id, value, original))}
    />
  );

  const chatRow = (c: Conversation, nested = false): ReactNode => {
    const active = p.view === "chat" && p.activeChatId === c.id;
    const isEditing = editing?.kind === "chat" && editing.id === c.id;
    return (
      <li
        key={c.id}
        className={`row ${nested ? "nested" : ""}`}
        data-active={active || undefined}
        data-menu={menu?.rowId === c.id || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          chatMenu(c, anchorFromPoint(e.clientX, e.clientY));
        }}
      >
        {isEditing ? (
          editRow("chat", c.id, c.title ?? "")
        ) : (
          <>
            <button type="button" className="row-main" aria-current={active ? "page" : undefined} onClick={() => p.onOpenChat(c.id)} title={c.title ?? "New chat"}>
              {c.pinned && <IconPin size={12} className="row-pin" />}
              <span className="row-text">{c.title ?? "New chat"}</span>
            </button>
            <button type="button" className="row-more" aria-label={`Actions for ${c.title ?? "chat"}`} aria-haspopup="menu" onClick={(e) => chatMenu(c, anchorFromEvent(e))}>
              <IconMore size={14} />
            </button>
          </>
        )}
      </li>
    );
  };

  const navItems: { key: View | "new" | "int"; label: string; icon: ReactNode; badge?: number; hint?: string; active?: boolean; run: () => void }[] = [
    { key: "new", label: "New chat", icon: <IconNewChat />, hint: `${MOD}⇧O`, run: p.onNewChat },
    { key: "chat", label: "Chat", icon: <IconChat />, active: p.view === "chat", run: () => p.onNav("chat") },
    { key: "runs", label: "Runs", icon: <IconRuns />, badge: p.pendingCount, active: p.view === "runs", run: () => p.onNav("runs") },
    { key: "files", label: "Folders", icon: <IconFolder />, active: p.view === "files", run: () => p.onNav("files") },
    { key: "analytics", label: "Analytics", icon: <IconChart />, active: p.view === "analytics", run: () => p.onNav("analytics") },
    { key: "int", label: "Integrations", icon: <IconPlug />, run: p.onOpenIntegrations },
  ];

  const confirmDialog = (
    <ConfirmDialog
      open={!!confirm}
      danger
      title={confirm?.kind === "project" ? "Delete project?" : "Delete chat?"}
      message={
        confirm?.kind === "project" ? (
          <>
            “{confirm.name}” will be deleted. Its chats are kept and move back to your chat list.
          </>
        ) : (
          <>“{confirm?.name}” and its messages will be permanently deleted.</>
        )
      }
      confirmLabel="Delete"
      onCancel={() => setConfirm(null)}
      onConfirm={() => {
        const c = confirm!;
        setConfirm(null);
        if (c.kind === "chat") void actions.deleteChat(c.id);
        else void actions.deleteProject(c.id);
      }}
    />
  );

  const menuEl = menu && <Menu anchor={menu.anchor} items={menu.items} label={menu.label} width={menu.width} align={menu.align} header={menu.header} side={menu.side} onClose={() => setMenu(null)} />;

  /* ── collapsed rail ── */
  if (p.collapsed) {
    return (
      <>
        <nav className="sidebar rail" aria-label="Primary">
          <button type="button" className="rail-btn" onClick={p.onToggleCollapsed} disabled={p.forcedCollapsed} aria-label="Expand sidebar" title={p.forcedCollapsed ? "Window too narrow to expand" : `Expand sidebar (${MOD}+B)`}>
            <Avatar text="M" size={24} tone="accent" />
          </button>
          <button type="button" className="rail-btn" onClick={p.onOpenPalette} aria-label="Search" title={`Search (${MOD}+K)`}>
            <IconSearch />
          </button>
          {navItems.map((n) => (
            <button key={n.key} type="button" className="rail-btn" data-active={n.active || undefined} onClick={n.run} aria-label={n.label} title={n.label}>
              {n.icon}
              {!!n.badge && <span className="rail-badge">{n.badge}</span>}
            </button>
          ))}
          <div className="rail-spacer" />
          <button type="button" className="rail-btn" onClick={userMenu} aria-label={`Account: ${p.userName}`} aria-haspopup="menu" title={p.userName}>
            <Avatar text={initials(p.userName)} size={24} />
          </button>
        </nav>
        {menuEl}
        {confirmDialog}
      </>
    );
  }

  return (
    <>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sb-head">
          <button type="button" className="ws-btn" onClick={workspaceMenu} aria-haspopup="menu" aria-label="Workspace menu">
            <Avatar text="M" size={20} tone="accent" />
            <span className="ws-name">Minimi</span>
            <IconChevronDown size={14} />
          </button>
          <button type="button" className="icon-btn" onClick={p.onToggleCollapsed} aria-label="Collapse sidebar" title={`Collapse sidebar (${MOD}+B)`}>
            <IconSidebar />
          </button>
        </div>

        <button type="button" className="search-field" onClick={p.onOpenPalette} aria-label="Search chats and commands">
          <IconSearch size={14} />
          <span>Search…</span>
          <kbd className="kbd">{MOD}K</kbd>
        </button>

        <nav className="sb-nav" aria-label="Primary">
          {navItems.map((n) => (
            <button key={n.key} type="button" className="nav-item" data-active={n.active || undefined} aria-current={n.active ? "page" : undefined} onClick={n.run}>
              {n.icon}
              <span>{n.label}</span>
              {!!n.badge && (
                <span className="badge" aria-label={`${n.badge} waiting for you`}>
                  <IconBell size={11} /> {n.badge}
                </span>
              )}
              {n.hint && <kbd className="kbd hint">{n.hint}</kbd>}
            </button>
          ))}
        </nav>

        <div className="sb-scroll">
          {pinned.length > 0 && (
            <section aria-label="Pinned chats">
              <h3 className="sb-title">Pinned</h3>
              <ul className="rows">{pinned.map((c) => chatRow(c))}</ul>
            </section>
          )}

          <section aria-label="Projects">
            <div className="sb-title-row">
              <h3 className="sb-title">Projects</h3>
              <button type="button" className="icon-btn sm" onClick={() => setCreating(true)} aria-label="New project" title="New project">
                <IconPlus size={14} />
              </button>
            </div>
            <ul className="rows">
              {creating && (
                <li className="row">
                  <NewProjectInput
                    onDone={async (name) => {
                      setCreating(false);
                      if (name) {
                        const id = await actions.createProject(name);
                        if (id) setExpanded((s) => new Set(s).add(id));
                      }
                    }}
                  />
                </li>
              )}
              {projects.map((pr) => {
                const open = expanded.has(pr.id);
                const kids = byProject.get(pr.id) ?? [];
                const isEditing = editing?.kind === "project" && editing.id === pr.id;
                return (
                  <li key={pr.id} className="proj">
                    <div className="row" data-menu={menu?.rowId === pr.id || undefined} onContextMenu={(e) => { e.preventDefault(); projectMenu(pr, anchorFromPoint(e.clientX, e.clientY)); }}>
                      {isEditing ? (
                        editRow("project", pr.id, pr.name)
                      ) : (
                        <>
                          <button type="button" className="row-main" aria-expanded={open} onClick={() => toggle(pr.id)} title={pr.name}>
                            <span className="chev" data-open={open}>
                              <IconChevronRight size={12} />
                            </span>
                            <IconFolder size={14} />
                            <span className="row-text">{pr.name}</span>
                            <span className="row-count">{kids.length || ""}</span>
                          </button>
                          <button type="button" className="row-more" aria-label={`Actions for ${pr.name}`} aria-haspopup="menu" onClick={(e) => projectMenu(pr, anchorFromEvent(e))}>
                            <IconMore size={14} />
                          </button>
                        </>
                      )}
                    </div>
                    {open && (
                      <ul className="rows nested-list">
                        {kids.length ? kids.map((c) => chatRow(c, true)) : <li className="row-empty">No chats yet</li>}
                      </ul>
                    )}
                  </li>
                );
              })}
              {!creating && projects.length === 0 && p.loaded && <li className="row-empty">No projects yet</li>}
            </ul>
          </section>

          <section aria-label="Chats">
            <div className="sb-title-row">
              <h3 className="sb-title">Chats</h3>
              <button type="button" className="icon-btn sm" onClick={p.onNewChat} aria-label="New chat" title={`New chat (${MOD}⇧O)`}>
                <IconNewChat size={14} />
              </button>
            </div>
            <ul className="rows">
              {loose.map((c) => chatRow(c))}
              {p.loaded && loose.length === 0 && <li className="row-empty">{conversations.length ? "All chats are pinned or in projects" : "Start a chat to see it here"}</li>}
              {!p.loaded && <li className="row-empty">Loading…</li>}
            </ul>
          </section>
        </div>

        <div className="sb-foot">
          <button type="button" className="user-btn" onClick={userMenu} aria-haspopup="menu" aria-label={`Account menu for ${p.userName}`}>
            <Avatar text={initials(p.userName)} size={22} />
            <span className="user-name">{p.userName}</span>
            <IconChevronDown size={14} />
          </button>
        </div>
      </aside>
      {menuEl}
      {confirmDialog}
    </>
  );
}

function EditInput({ original, max, label, onDone }: { original: string; max: number; label: string; onDone: (v: string | null) => void }) {
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      className="row-input"
      name="rename"
      defaultValue={original}
      maxLength={max}
      aria-label={label}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}

function NewProjectInput({ onDone }: { onDone: (name: string | null) => void }) {
  const done = useRef(false);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v && v.trim() ? v.trim() : null);
  };
  return (
    <input
      className="row-input"
      name="project-name"
      placeholder="Project name"
      aria-label="New project name"
      maxLength={60}
      autoFocus
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        else if (e.key === "Escape") {
          e.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
