import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Integrations } from "./api";
import { usePendingApprovals } from "./chat/approvals";
import { ChatView } from "./chat/ChatView";
import { ClockDialog, NameDialog, ShortcutsDialog } from "./shell/Dialogs";
import { IntegrationsModal } from "./shell/IntegrationsModal";
import { Palette } from "./shell/Palette";
import { Sidebar, type View } from "./shell/Sidebar";
import { ToastProvider, useToast } from "./shell/toast";
import { useWorkspace } from "./shell/data";
import { useMediaQuery, useStored, useTheme } from "./shell/util";
import { AnalyticsView } from "./views/AnalyticsView";
import { FilesView } from "./views/FilesView";
import { RunsView } from "./views/RunsView";
import { setNotifyPrefs } from "./shell/notify";
import { SettingsView } from "./views/SettingsView";

type Route = { view: View; id?: string };

/* Clean path URLs under /app (e.g. /app/settings/privacy, /app/runs/<id>), no "#". The server answers every
   /app/* with index.html. Old "#/..." links are still understood and rewritten once on load. */
const BASE = "/app";

function parseSegments(segs: string[]): Route {
  const [v, id] = segs;
  const rid = id ? decodeURIComponent(id) : undefined;
  if (v === "runs") return { view: "runs", id: rid };
  if (v === "files") return { view: "files" };
  if (v === "analytics") return { view: "analytics" };
  if (v === "settings") return { view: "settings", id: rid }; // id = section
  return { view: "chat", id: rid };
}
function parseLocation(): Route {
  // Legacy hash URL (#/settings) wins when present so old bookmarks keep working.
  if (location.hash.startsWith("#/")) return parseSegments(location.hash.slice(2).split("/").filter(Boolean));
  const path = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  return parseSegments(path.split("/").filter(Boolean));
}
const pathOf = (r: Route) => `${BASE}/${r.view}${r.id ? `/${encodeURIComponent(r.id)}` : ""}`;

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const toast = useToast();
  const ws = useWorkspace(toast);
  const pending = usePendingApprovals();
  const [theme, setTheme] = useTheme();
  const [route, setRoute] = useState<Route>(parseLocation);
  const [collapsedPref, setCollapsedPref] = useStored<boolean>("minimi.sidebar.collapsed", false);
  const narrow = useMediaQuery("(max-width: 899px)");
  const collapsed = narrow || collapsedPref;
  const [userName, setUserName] = useStored<string>("minimi.name", "You");
  // Settings saves the display name and announces it, so the sidebar row updates without a reload.
  useEffect(() => {
    const on = (e: Event) => {
      const n = (e as CustomEvent<string>).detail;
      if (typeof n === "string") setUserName(n);
    };
    window.addEventListener("minimi:name", on);
    return () => window.removeEventListener("minimi:name", on);
  }, [setUserName]);
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [devRoutes, setDevRoutes] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [newProjectSignal, setNewProjectSignal] = useState(0);
  const [dialog, setDialog] = useState<null | "palette" | "integrations" | "shortcuts" | "name" | "clock">(null);

  /* ── routing ── */
  const go = useCallback((r: Route, replace = false) => {
    const p = pathOf(r);
    if (location.pathname !== p || location.hash) {
      if (replace) history.replaceState(null, "", p);
      else history.pushState(null, "", p);
    }
    setRoute((cur) => (cur.view === r.view && cur.id === r.id ? cur : r));
  }, []);
  useEffect(() => {
    // Rewrite a legacy "#/view" URL to its clean path without adding a history entry.
    if (location.hash.startsWith("#/")) history.replaceState(null, "", pathOf(parseLocation()));
    const on = () => setRoute(parseLocation());
    window.addEventListener("popstate", on);
    // Other modules navigate with a plain "/app/..." path via this event (see lib navigate()).
    const nav = (e: Event) => {
      const to = (e as CustomEvent<string>).detail;
      if (typeof to === "string") {
        history.pushState(null, "", to);
        setRoute(parseLocation());
      }
    };
    window.addEventListener("minimi:navigate", nav);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("minimi:navigate", nav);
    };
  }, []);

  const newChat = useCallback(() => {
    go({ view: "chat" });
    setFocusToken((n) => n + 1);
  }, [go]);
  const openChat = useCallback((id: string) => go({ view: "chat", id }), [go]);

  /* ── one-time loads ── */
  useEffect(() => {
    api.integrations().then(setIntegrations).catch(() => {});
    api.health().then((h) => setDevRoutes(Boolean(h.devRoutes))).catch(() => {});
    // Mirror server-side profile/workspace settings into this browser so a fresh browser shows them too.
    api
      .preferences()
      .then((p) => {
        setNotifyPrefs(p);
        const put = (k: string, v: string) => {
          try {
            localStorage.setItem(k, v);
          } catch {
            /* storage unavailable */
          }
        };
        if (p.displayName) {
          put("minimi.name", p.displayName);
          setUserName(p.displayName);
        }
        if (p.workspaceName) put("minimi.workspace", p.workspaceName);
        put("minimi.tz", p.timezone);
        window.dispatchEvent(new CustomEvent("minimi:stored", { detail: { key: "minimi.workspace", value: p.workspaceName } }));
      })
      .catch(() => {});
    const openInt = () => setDialog("integrations");
    window.addEventListener("minimi:open-integrations", openInt);
    return () => window.removeEventListener("minimi:open-integrations", openInt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── shortcuts ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "k" && !e.shiftKey) {
        e.preventDefault();
        setDialog((d) => (d === "palette" ? null : "palette"));
      } else if (k === "o" && e.shiftKey) {
        e.preventDefault();
        newChat();
      } else if (k === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setCollapsedPref(!collapsedPref);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, collapsedPref, setCollapsedPref]);

  /* ── actions, wrapped so deleting the open chat leaves it ── */
  const actions = useMemo(
    () => ({
      ...ws.actions,
      deleteChat: async (id: string) => {
        const ok = await ws.actions.deleteChat(id);
        const cur = parseLocation();
        if (ok && cur.id === id && cur.view === "chat") go({ view: "chat" }, true);
        return ok;
      },
    }),
    [ws.actions, go],
  );

  const paletteCommands = useMemo(
    () => ({
      newChat,
      runs: () => go({ view: "runs" }),
      files: () => go({ view: "files" }),
      analytics: () => go({ view: "analytics" }),
      integrations: () => setDialog("integrations"),
      toggleSidebar: () => setCollapsedPref(!collapsedPref),
      toggleTheme: () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"),
    }),
    [newChat, go, collapsedPref, setCollapsedPref, setTheme],
  );

  const activeChatId = route.view === "chat" ? route.id : undefined;
  // While another view is showing, ChatView stays pointed at the chat that was last open.
  const keptChat = useRef<string | undefined>(route.view === "chat" ? route.id : undefined);
  if (route.view === "chat") keptChat.current = route.id;

  return (
    <div className="app" data-view={route.view}>
      {route.view !== "settings" && (
      <Sidebar
        conversations={ws.conversations}
        projects={ws.projects}
        loaded={ws.loaded}
        activeChatId={activeChatId}
        view={route.view}
        collapsed={collapsed}
        forcedCollapsed={narrow}
        pendingCount={pending.length}
        userName={userName}
        theme={theme}
        newProjectSignal={newProjectSignal}
        onToggleCollapsed={() => setCollapsedPref(!collapsedPref)}
        onNewChat={newChat}
        onOpenChat={openChat}
        onNav={(v) => go(v === "chat" ? { view: "chat", id: keptChat.current } : { view: v })}
        onOpenPalette={() => setDialog("palette")}
        onOpenIntegrations={() => setDialog("integrations")}
        onOpenSettings={() => go({ view: "settings" })}
        onOpenShortcuts={() => setDialog("shortcuts")}
        onSetTheme={setTheme}
        onNewProject={() => {
          if (collapsedPref && !narrow) setCollapsedPref(false);
          setNewProjectSignal((n) => n + 1);
        }}
        actions={actions}
      />
      )}

      <main className="main" id="main">
        {/* ChatView stays mounted so an in-flight answer keeps streaming while you browse other views. */}
        <div className="pane" hidden={route.view !== "chat"}>
          <ChatView
            conversationId={keptChat.current}
            integrations={integrations}
            onConversationCreated={(id) => {
              go({ view: "chat", id }, true);
              void ws.refresh();
            }}
            onChanged={() => void ws.refresh()}
            onOpenRun={(turnId) => go({ view: "runs", id: turnId })}
            focusToken={focusToken}
            onOpenIntegrations={() => setDialog("integrations")}
          />
        </div>
        {route.view === "runs" && (
          <div className="pane">
            <RunsView selectedId={route.id} onSelect={(id) => go({ view: "runs", id }, true)} onOpenChat={openChat} />
          </div>
        )}
        {route.view === "files" && (
          <div className="pane">
            <FilesView projects={ws.projects} onOpenChat={openChat} onCreateProject={ws.actions.createProject} onChanged={() => void ws.refresh()} />
          </div>
        )}
        {route.view === "analytics" && (
          <div className="pane">
            <AnalyticsView />
          </div>
        )}
        {route.view === "settings" && (
          <div className="pane">
            <SettingsView
              section={route.id}
              onSection={(s) => go({ view: "settings", id: s }, true)}
              onBack={() => go({ view: "chat", id: keptChat.current })}
            />
          </div>
        )}
      </main>

      <Palette
        open={dialog === "palette"}
        onClose={() => setDialog(null)}
        conversations={ws.conversations}
        onOpenChat={openChat}
        commands={paletteCommands}
      />
      <IntegrationsModal open={dialog === "integrations"} onClose={() => setDialog(null)} integrations={integrations} onUpdated={setIntegrations} />
      <ShortcutsDialog open={dialog === "shortcuts"} onClose={() => setDialog(null)} />
      <NameDialog open={dialog === "name"} onClose={() => setDialog(null)} name={userName} onSave={setUserName} />
      <ClockDialog open={dialog === "clock"} onClose={() => setDialog(null)} />
    </div>
  );
}
