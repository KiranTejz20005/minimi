import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Conversation, type Project } from "../api";
import { errMsg } from "./util";

export interface WorkspaceActions {
  pinChat(id: string, pinned: boolean): Promise<boolean>;
  renameChat(id: string, title: string): Promise<boolean>;
  moveChat(id: string, projectId: string | null): Promise<boolean>;
  deleteChat(id: string): Promise<boolean>;
  createProject(name: string): Promise<string | null>;
  renameProject(id: string, name: string): Promise<boolean>;
  deleteProject(id: string): Promise<boolean>;
}

type Toast = (text: string, kind?: "info" | "success" | "error") => void;

/** Conversations + projects with optimistic mutations (rollback by refetch + toast on failure). */
export function useWorkspace(toast: Toast) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await api.listConversations();
      if (my !== seq.current) return; // a newer refresh superseded this one
      setConversations(d.conversations);
      setProjects(d.projects);
    } catch (e) {
      if (my === seq.current) toast(`Couldn't load chats: ${errMsg(e)}`, "error");
    } finally {
      if (my === seq.current) setLoaded(true);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const actions = useMemo<WorkspaceActions>(() => {
    const run = async (optimistic: () => void, call: () => Promise<unknown>, failure: string): Promise<boolean> => {
      optimistic();
      try {
        await call();
        return true;
      } catch (e) {
        toast(`${failure}: ${errMsg(e)}`, "error");
        void refresh();
        return false;
      }
    };
    const patchConv = (id: string, p: Partial<Conversation>) =>
      setConversations((l) => l.map((c) => (c.id === id ? { ...c, ...p } : c)));

    return {
      pinChat: (id, pinned) =>
        run(() => patchConv(id, { pinned }), async () => {
          await api.patchConversation(id, { pinned });
          void refresh();
        }, "Couldn't update pin"),
      renameChat: (id, title) =>
        run(() => patchConv(id, { title }), async () => {
          await api.patchConversation(id, { title });
          void refresh();
        }, "Couldn't rename chat"),
      moveChat: (id, projectId) =>
        run(() => patchConv(id, { project_id: projectId }), async () => {
          await api.patchConversation(id, { projectId });
          void refresh();
        }, "Couldn't move chat"),
      deleteChat: (id) =>
        run(() => setConversations((l) => l.filter((c) => c.id !== id)), async () => {
          await api.deleteConversation(id);
          void refresh();
        }, "Couldn't delete chat"),
      createProject: async (name) => {
        try {
          const p = await api.createProject(name);
          await refresh();
          return p.id;
        } catch (e) {
          toast(`Couldn't create project: ${errMsg(e)}`, "error");
          return null;
        }
      },
      renameProject: (id, name) =>
        run(() => setProjects((l) => l.map((p) => (p.id === id ? { ...p, name } : p))), async () => {
          await api.renameProject(id, name);
          void refresh();
        }, "Couldn't rename project"),
      deleteProject: (id) =>
        run(
          () => {
            setProjects((l) => l.filter((p) => p.id !== id));
            setConversations((l) => l.map((c) => (c.project_id === id ? { ...c, project_id: null } : c)));
          },
          async () => {
            await api.deleteProject(id);
            void refresh();
          },
          "Couldn't delete project",
        ),
    };
  }, [refresh, toast]);

  return { conversations, projects, loaded, refresh, actions };
}
