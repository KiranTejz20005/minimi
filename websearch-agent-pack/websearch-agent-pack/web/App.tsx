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

type Route = { view: View; id?: string };

function parseHash(): Route {
  const [v, id] = location.hash.replace(/^#\/?/, "").split("/");
  const rid = id ? decodeURIComponent(id) : undefined;
  if (v === "runs") return { view: "runs", id: rid };
  if (v === "files") return { view: "files" };
  if (v === "analytics") return { view: "analytics" };
  return { view: "chat", id: rid };
}
const hashOf = (r: Route) => `#/${r.view}${r.id ? `/${encodeURIComponent(r.id)}` : ""}`;

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
  const [route, setRoute] = useState<Route>(parseHash);
  const [collapsedPref, setCollapsedPref] = useStored<boolean>("minimi.sidebar.collapsed", false);
  const narrow = useMediaQuery("(max-width: 899px)");
  const collapsed = narrow || collapsedPref;
  const [userName, setUserName] = useStored<string>("minimi.name", "You");
  const [integrations, setIntegrations] = useState<Integrations | null>(null);
  const [devRoutes, setDevRoutes] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const [newProjectSignal, setNewProjectSignal] = useState(0);
  const [dialog, setDialog] = useState<null | "palette" | "integrations" | "shortcuts" | "name" | "clock">(null);

  /* ── routing ── */
  const go = useCallback((r: Route, replace = false) => {
    const h = hashOf(r);
    if (location.hash !== h) {
      if (replace) history.replaceState(null, "", h);
      else location.hash = h;
    }
    setRoute((cur) => (cur.view === r.view && cur.id === r.id ? cur : r));
  }, []);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
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
        if (ok && parseHash().id === id && parseHash().view === "chat") go({ view: "chat" }, true);
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
    <div className="app">
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
        onOpenShortcuts={() => setDialog("shortcuts")}
        onEditName={() => setDialog("name")}
        onSetTheme={setTheme}
        onOpenClock={devRoutes ? () => setDialog("clock") : undefined}
        onNewProject={() => {
          if (collapsedPref && !narrow) setCollapsedPref(false);
          setNewProjectSignal((n) => n + 1);
        }}
        actions={actions}
      />

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
