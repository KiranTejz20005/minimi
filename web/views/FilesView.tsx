import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, type AttachmentRef, type FileRow, type Project } from "../api";
import { IconChat, IconDownload, IconFile, IconFolder, IconGrid, IconList, IconPlus, IconSearch, IconTrash, IconUpload, IconX } from "../shell/icons";
import { useToast } from "../shell/toast";
import { ConfirmDialog, Dialog, Empty, Spinner } from "../shell/ui";
import { ContextMenu, Loading, Skeleton, TreeView, type TreeNode } from "../ui";
import { SideFolder } from "../ui/SideFolder";
import { errMsg, fmtBytes, relTime, useStored } from "../shell/util";

const KIND_LABEL: Record<string, string> = { MD: "MD", CSV: "CSV", JSON: "JSON", CODE: "CODE", TXT: "TXT" };

function Badge({ kind }: { kind: string }) {
  return (
    <span className="file-badge" data-kind={kind}>
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

export function FilesView({
  projects,
  onOpenChat,
  onCreateProject,
  onChanged,
}: {
  projects: Project[];
  onOpenChat: (id: string) => void;
  onCreateProject: (name: string) => Promise<string | null>;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [folderFilter, setFolderFilter] = useState<"all" | "with" | "empty">("all");
  const [folderQuery, setFolderQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [layout, setLayout] = useStored<string>("minimi.files.layout", "grid");
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setFiles((await api.listFiles()).files);
    } catch (e) {
      toast(`Couldn't load files: ${errMsg(e)}`, "error");
      setFiles((f) => f ?? []);
    }
  }, [toast]);
  useEffect(() => void load(), [load]);

  // The selected folder may be deleted from the sidebar meanwhile.
  useEffect(() => {
    if (selectedProject && !projects.some((p) => p.id === selectedProject)) setSelectedProject(null);
  }, [projects, selectedProject]);

  const shownProjects = useMemo(
    () =>
      projects.filter((p) => {
        if (folderQuery && !p.name.toLowerCase().includes(folderQuery.toLowerCase())) return false;
        if (folderFilter === "with") return p.file_count > 0;
        if (folderFilter === "empty") return p.file_count === 0;
        return true;
      }),
    [projects, folderQuery, folderFilter],
  );

  const shownFiles = useMemo(
    () =>
      (files ?? []).filter((f) => {
        if (selectedProject && f.project_id !== selectedProject) return false;
        if (fileQuery && !f.name.toLowerCase().includes(fileQuery.toLowerCase())) return false;
        return true;
      }),
    [files, selectedProject, fileQuery],
  );

  const upload = async (list: FileList | File[]) => {
    const arr = [...list];
    if (!arr.length) return;
    setUploading(true);
    let ok = 0;
    for (const f of arr) {
      try {
        if (f.size > 500_000) throw new Error("larger than 500 KB");
        const content = await f.text();
        await api.uploadFile({ name: f.name, mime: f.type || undefined, content });
        ok++;
      } catch (e) {
        toast(`${f.name}: ${errMsg(e)}`, "error");
      }
    }
    setUploading(false);
    if (ok) {
      toast(ok === 1 ? "File uploaded" : `${ok} files uploaded`, "success");
      void load();
      onChanged();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void upload(e.dataTransfer.files);
  };

  const createFolder = async () => {
    const n = newName.trim();
    if (!n) return;
    const id = await onCreateProject(n);
    if (id) {
      setCreating(false);
      setNewName("");
      toast(`Folder “${n}” created`, "success");
    }
  };

  const selected = projects.find((p) => p.id === selectedProject);

  const fileTree = useMemo((): TreeNode[] => {
    if (!files) return [];
    const unfiled = files.filter((f) => !f.project_id);
    const nodes: TreeNode[] = shownProjects.map((p) => ({
      id: `proj:${p.id}`,
      label: p.name,
      icon: <IconFolder size={16} />,
      meta: p.file_count,
      children: files
        .filter((f) => f.project_id === p.id)
        .map((f) => ({ id: `file:${f.id}`, label: f.name, icon: <IconFile size={16} />, meta: f.kind })),
    }));
    if (unfiled.length) {
      nodes.push({
        id: "proj:unfiled",
        label: "Not in a folder",
        icon: <IconFile size={16} />,
        children: unfiled.map((f) => ({ id: `file:${f.id}`, label: f.name, icon: <IconFile size={16} />, meta: f.kind })),
      });
    }
    return nodes;
  }, [files, shownProjects]);

  const onTreeSelect = (id: string) => {
    if (id.startsWith("file:")) {
      const fid = id.slice(5);
      const f = files?.find((x) => x.id === fid);
      if (f) setPreview(f);
    } else if (id.startsWith("proj:") && id !== "proj:unfiled") {
      setSelectedProject(id.slice(5));
    }
  };

  return (
    <div
      className="view files-view"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="view-inner">
        <header className="view-head">
          <h1>Files</h1>
          <p>See files you attached in chats and manage the folders (projects) they live in.</p>
        </header>

        <section aria-labelledby="folders-h">
          <div className="section-bar">
            <h2 id="folders-h" className="eyebrow">
              Folders <span>{projects.length}</span>
            </h2>
          </div>
          <div className="toolbar">
            <div className="seg" role="group" aria-label="Filter folders">
              {(["all", "with", "empty"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={folderFilter === k} onClick={() => setFolderFilter(k)}>
                  {k === "all" ? "All" : k === "with" ? "With files" : "Empty"}
                </button>
              ))}
            </div>
            <span className="grow" />
            <div className="seg icons" role="group" aria-label="Layout">
              <button type="button" aria-pressed={layout === "grid"} aria-label="Grid view" onClick={() => setLayout("grid")}>
                <IconGrid size={14} />
              </button>
              <button type="button" aria-pressed={layout === "list"} aria-label="List view" onClick={() => setLayout("list")}>
                <IconList size={14} />
              </button>
            </div>
            <label className="search-input">
              <IconSearch size={14} />
              <input name="folder-search" value={folderQuery} onChange={(e) => setFolderQuery(e.target.value)} placeholder="Search folders…" aria-label="Search folders" />
            </label>
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <IconPlus size={14} /> Create folder
            </button>
          </div>

          {shownProjects.length ? (
            <div className="folders" data-layout={layout}>
              {shownProjects.map((p) => (
                <ContextMenu
                  key={p.id}
                  aria-label={`Actions for ${p.name}`}
                  items={[
                    {
                      label: "Open folder",
                      onSelect: () => setSelectedProject(selectedProject === p.id ? null : p.id),
                    },
                    {
                      label: "Clear filter",
                      disabled: selectedProject !== p.id,
                      onSelect: () => setSelectedProject(null),
                    },
                  ]}
                >
                  <button type="button" className="folder-card" aria-pressed={selectedProject === p.id} onClick={() => setSelectedProject(selectedProject === p.id ? null : p.id)}>
                    <span className="folder-ico">
                      <IconFolder size={22} />
                    </span>
                    <span className="folder-text">
                      <strong>{p.name}</strong>
                      <small>
                        {p.chat_count} {p.chat_count === 1 ? "chat" : "chats"} · {p.file_count} {p.file_count === 1 ? "file" : "files"}
                      </small>
                    </span>
                  </button>
                </ContextMenu>
              ))}
            </div>
          ) : (
            <Empty icon={<IconFolder size={22} />} title={projects.length ? "No folders match" : "No folders yet"}>
              {!projects.length && <SideFolder className="files-empty-art" />}
              {projects.length ? "Try a different filter or search." : "Folders are projects — create one to group related chats and their files."}
            </Empty>
          )}

          {files !== null && fileTree.length > 0 && (
            <TreeView items={fileTree} aria-label="Projects and files" className="files-tree" onSelect={onTreeSelect} defaultExpanded={shownProjects.slice(0, 3).map((p) => `proj:${p.id}`)} />
          )}
        </section>

        <section aria-labelledby="files-h">
          <div className="section-bar">
            <h2 id="files-h" className="eyebrow">
              Recent files <span>{shownFiles.length}</span>
            </h2>
            {selected && (
              <button type="button" className="chip" onClick={() => setSelectedProject(null)} aria-label={`Clear folder filter ${selected.name}`}>
                <IconFolder size={12} /> {selected.name} <IconX size={12} />
              </button>
            )}
          </div>
          <div className="toolbar">
            <span className="grow" />
            <label className="search-input">
              <IconSearch size={14} />
              <input name="file-search" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} placeholder="Search files…" aria-label="Search files" />
            </label>
            <input ref={inputRef} type="file" multiple hidden accept="text/*,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.html,.css,.sql,.sh,.yml,.yaml,.xml,.txt,.log" onChange={(e) => {
              if (e.target.files) void upload(e.target.files);
              e.target.value = "";
            }} />
            <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
              <IconUpload size={14} /> {uploading ? "Uploading…" : "Upload file"}
            </button>
          </div>

          {files === null ? (
            <Loading label="Loading files" className="files-grid-loading">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} height={140} radius={10} />
              ))}
            </Loading>
          ) : shownFiles.length ? (
            <div className="files-grid">
              {shownFiles.map((f) => (
                <button key={f.id} type="button" className="file-card" onClick={() => setPreview(f)}>
                  <div className="file-thumb">
                    <IconFile size={34} />
                    <Badge kind={f.kind} />
                  </div>
                  <strong title={f.name}>{f.name}</strong>
                  <small>
                    {f.kind} · {fmtBytes(f.size)} · {f.conversation_title ?? "Not in a chat"}
                  </small>
                </button>
              ))}
            </div>
          ) : (
            <Empty icon={<IconFile size={22} />} title={files.length ? "No files match" : "No files yet"}>
              {files.length ? "Clear the filter or search to see all files." : "Attach text files in a chat, or drop them here to upload."}
            </Empty>
          )}
        </section>
      </div>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <IconUpload size={22} /> Drop text files to upload
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create folder"
        width={380}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={createFolder} disabled={!newName.trim()}>
              Create
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="folder-name">
          Folder name
        </label>
        <input id="folder-name" className="input" value={newName} maxLength={60} data-autofocus onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createFolder()} />
      </Dialog>

      <FilePreview
        file={preview}
        onClose={() => setPreview(null)}
        onOpenChat={(id) => {
          setPreview(null);
          onOpenChat(id);
        }}
        onDeleted={() => {
          setPreview(null);
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

function FilePreview({ file, onClose, onOpenChat, onDeleted }: { file: FileRow | null; onClose: () => void; onOpenChat: (id: string) => void; onDeleted: () => void }) {
  const toast = useToast();
  const [data, setData] = useState<(AttachmentRef & { content: string }) | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    setData(null);
    setConfirm(false);
    if (!file) return;
    let live = true;
    api
      .getFile(file.id)
      .then((d) => live && setData(d))
      .catch((e) => {
        toast(`Couldn't open file: ${errMsg(e)}`, "error");
        onClose();
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data.content], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = data.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const del = async () => {
    if (!file) return;
    try {
      await api.deleteFile(file.id);
      toast("File deleted", "success");
      onDeleted();
    } catch (e) {
      toast(`Couldn't delete: ${errMsg(e)}`, "error");
      setConfirm(false);
    }
  };

  return (
    <>
      <Dialog
        open={!!file && !confirm}
        onClose={onClose}
        title={file?.name ?? "File"}
        width={720}
        className="preview-dialog"
        footer={
          <>
            {file?.conversation_id && (
              <button type="button" className="btn" onClick={() => onOpenChat(file.conversation_id!)}>
                <IconChat size={14} /> Open chat
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirm(true)}>
              <IconTrash size={14} /> Delete
            </button>
            <button type="button" className="btn btn-primary" onClick={download} disabled={!data}>
              <IconDownload size={14} /> Download
            </button>
          </>
        }
      >
        <p className="small muted">
          {file && (
            <>
              {file.kind} · {fmtBytes(file.size)} · added {relTime(file.created_at)}
              {file.project_name ? ` · in ${file.project_name}` : ""}
            </>
          )}
        </p>
        {data ? <pre className="file-pre">{data.content}</pre> : <div className="loading-row"><Spinner /></div>}
      </Dialog>
      <ConfirmDialog open={!!file && confirm} danger title="Delete file?" message={<>“{file?.name}” will be permanently deleted.</>} confirmLabel="Delete" onCancel={() => setConfirm(false)} onConfirm={() => void del()} />
    </>
  );
}
