import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, type AttachmentRef, type FileRow, type Project } from "../api";
import { FOLDER_COLORS, FOLDER_COLOR_ORDER, FolderIcon, IconChat, IconDownload, IconFile, IconFolder, IconGrid, IconList, IconPlus, IconSearch, IconTrash, IconUpload } from "../shell/icons";
import { useToast } from "../shell/toast";
import { ConfirmDialog, Dialog, Empty, Spinner } from "../shell/ui";
import { ContextMenu, Loading, Skeleton } from "../ui";
import { SideFolder } from "../ui/SideFolder";
import { errMsg, fmtBytes, relTime, useStored } from "../shell/util";

/* Callers: App.tsx Files route. User: folders end to end (create/rename/delete, upload into a folder,
   move files, detail page, filters/sort), document-style cards like the reference screens. */

const KIND_LABEL: Record<string, string> = { MD: "MD", CSV: "CSV", JSON: "JSON", CODE: "CODE", TXT: "TXT" };
const KIND_NAME: Record<string, string> = { MD: "Markdown", CSV: "Spreadsheet", JSON: "JSON", CODE: "Code", TXT: "Text" };
const ACCEPT = "text/*,.md,.csv,.json,.ts,.tsx,.js,.jsx,.py,.go,.rs,.java,.html,.css,.sql,.sh,.yml,.yaml,.xml,.txt,.log";

type FolderFilter = "all" | "with" | "empty";
type FolderSort = "recent" | "name" | "files";

function Badge({ kind }: { kind: string }) {
  return (
    <span className="file-badge" data-kind={kind}>
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

/** Document-style card (page glyph with a type badge) shared by the home grid and the folder page. */
function FileCard({ f, onOpen }: { f: FileRow; onOpen: () => void }) {
  return (
    <button type="button" className="file-card" onClick={onOpen}>
      <div className="file-thumb">
        <span className="file-page" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <Badge kind={f.kind} />
      </div>
      <strong title={f.name}>{f.name}</strong>
      <small>
        {KIND_NAME[f.kind] ?? f.kind} · {fmtBytes(f.size)} · {relTime(f.created_at)}
      </small>
    </button>
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
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("all");
  const [folderSort, setFolderSort] = useStored<FolderSort>("minimi.files.sort", "recent");
  const [folderQuery, setFolderQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [layout, setLayout] = useStored<string>("minimi.files.layout", "grid");
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setFiles((await api.listFiles()).files);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(errMsg(e));
      setFiles((f) => f ?? []);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const folder = projects.find((p) => p.id === openId) ?? null;
  // The open folder may be deleted from the sidebar meanwhile.
  useEffect(() => {
    if (openId && !projects.some((p) => p.id === openId)) setOpenId(null);
  }, [projects, openId]);

  const shownFolders = useMemo(() => {
    const list = projects.filter((p) => {
      if (folderQuery && !p.name.toLowerCase().includes(folderQuery.toLowerCase())) return false;
      if (folderFilter === "with") return p.file_count > 0;
      if (folderFilter === "empty") return p.file_count === 0;
      return true;
    });
    return [...list].sort((a, b) =>
      folderSort === "name" ? a.name.localeCompare(b.name) : folderSort === "files" ? b.file_count - a.file_count : b.created_at.localeCompare(a.created_at),
    );
  }, [projects, folderQuery, folderFilter, folderSort]);

  const kinds = useMemo(() => [...new Set((files ?? []).map((f) => f.kind))].sort(), [files]);

  const shownFiles = useMemo(
    () =>
      (files ?? []).filter((f) => {
        if (openId && f.project_id !== openId) return false;
        if (typeFilter !== "all" && f.kind !== typeFilter) return false;
        if (fileQuery && !f.name.toLowerCase().includes(fileQuery.toLowerCase())) return false;
        return true;
      }),
    [files, openId, typeFilter, fileQuery],
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
        await api.uploadFile({ name: f.name, mime: f.type || undefined, content, projectId: openId ?? undefined });
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
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const id = await onCreateProject(n);
    setBusy(false);
    if (id) {
      setCreating(false);
      setName("");
      toast(`Folder “${n}” created`, "success");
    }
  };

  const renameFolder = async () => {
    const n = name.trim();
    if (!renaming || !n || busy) return;
    setBusy(true);
    try {
      await api.renameProject(renaming.id, n);
      toast("Folder renamed", "success");
      setRenaming(null);
      onChanged();
      void load();
    } catch (e) {
      toast(`Couldn't rename: ${errMsg(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteFolder = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await api.deleteProject(deleting.id);
      toast(`Folder “${deleting.name}” deleted. Its files are kept.`, "success");
      if (openId === deleting.id) setOpenId(null);
      setDeleting(null);
      onChanged();
      void load();
    } catch (e) {
      toast(`Couldn't delete: ${errMsg(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  /** Palette submenu with a check on the current color. The change itself is handled by useWorkspace (instant + rollback). */
  const colorItems = (p: Project) =>
    FOLDER_COLOR_ORDER.map((col) => ({
      label: FOLDER_COLORS[col].label,
      icon: <FolderIcon color={col} size={16} />,
      checked: p.color === col,
      onSelect: () => {
        if (p.color !== col) window.dispatchEvent(new CustomEvent("minimi:project-color", { detail: { id: p.id, color: col } }));
      },
    }));

  const startRename = (p: Project) => {
    setName(p.name);
    setRenaming(p);
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      hidden
      accept={ACCEPT}
      onChange={(e) => {
        if (e.target.files) void upload(e.target.files);
        e.target.value = "";
      }}
    />
  );

  const filesBody =
    files === null ? (
      <Loading label="Loading files" className="files-grid-loading">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} height={150} radius={10} />
        ))}
      </Loading>
    ) : loadErr && files.length === 0 ? (
      <Empty icon={<IconFile size={22} />} title="Couldn't load files">
        {loadErr}{" "}
        <button type="button" className="btn sm" onClick={() => void load()}>
          Retry
        </button>
      </Empty>
    ) : shownFiles.length ? (
      <div className="files-grid">
        {shownFiles.map((f) => (
          <FileCard key={f.id} f={f} onOpen={() => setPreview(f)} />
        ))}
      </div>
    ) : (
      <Empty icon={<IconFile size={22} />} title={files.length && !openId ? "No files match" : openId ? "This folder is empty" : "No files yet"}>
        {files.length && !openId
          ? "Clear the filter or search to see all files."
          : openId
            ? "Upload files here, or drop them anywhere on this page."
            : "Attach text files in a chat, or drop them here to upload."}
      </Empty>
    );

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
        {folder ? (
          <>
            <nav className="crumbs files-crumbs" aria-label="Breadcrumb">
              <button type="button" className="crumb-link" onClick={() => setOpenId(null)}>
                Files
              </button>
              <span>/</span>
              <strong>{folder.name}</strong>
            </nav>
            <button type="button" className="crumb-back" onClick={() => setOpenId(null)}>
              ← Files
            </button>
            <header className="folder-head">
              <h1>
                <ContextMenu aria-label={`Change color of ${folder.name}`} items={colorItems(folder)}>
                  <button
                    type="button"
                    className="folder-ico folder-ico--btn"
                    title="Change color"
                    aria-label="Change folder color"
                    aria-haspopup="menu"
                    onClick={(e) => {
                      // The menu opens on a context-menu event; a plain click asks for the same thing at the button.
                      const r = e.currentTarget.getBoundingClientRect();
                      e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom + 4 }));
                    }}
                  >
                    <FolderIcon color={folder.color} size={28} />
                  </button>
                </ContextMenu>
                {folder.name}
              </h1>
              <span className="grow" />
              <button type="button" className="btn" onClick={() => startRename(folder)}>
                Rename
              </button>
              <button type="button" className="btn btn-danger-ghost" onClick={() => setDeleting(folder)}>
                <IconTrash size={14} /> Delete
              </button>
              <button type="button" className="btn btn-primary" onClick={() => inputRef.current?.click()} disabled={uploading}>
                <IconUpload size={14} /> {uploading ? "Uploading…" : "Upload files"}
              </button>
              {fileInput}
            </header>
            <p className="small muted">
              {folder.file_count} {folder.file_count === 1 ? "file" : "files"} · {folder.chat_count} {folder.chat_count === 1 ? "chat" : "chats"} · created {relTime(folder.created_at)}
            </p>
            {files !== null && files.some((f) => f.project_id === folder.id) && (
              <div className="toolbar">
                <span className="grow" />
                <label className="search-input">
                  <IconSearch size={14} />
                  <input name="file-search" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} placeholder="Search files…" aria-label="Search files" />
                </label>
              </div>
            )}
            {filesBody}
          </>
        ) : (
          <>
            <header className="view-head">
              <h1>Files</h1>
              <p>See files you recently used in chats and manage the folders they are saved in.</p>
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
                <select className="select-sm" aria-label="Sort folders" value={folderSort} onChange={(e) => setFolderSort(e.target.value as FolderSort)}>
                  <option value="recent">Newest</option>
                  <option value="name">Name</option>
                  <option value="files">Most files</option>
                </select>
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
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    setName("");
                    setCreating(true);
                  }}
                >
                  <IconPlus size={14} /> Create folder
                </button>
              </div>

              {shownFolders.length ? (
                <div className="folders" data-layout={layout}>
                  {shownFolders.map((p) => (
                    <ContextMenu
                      key={p.id}
                      aria-label={`Actions for ${p.name}`}
                      items={[
                        { label: "Open folder", onSelect: () => setOpenId(p.id) },
                        { label: "Rename", onSelect: () => startRename(p) },
                        { label: "Change color", icon: <FolderIcon color={p.color} size={16} />, submenu: colorItems(p) },
                        { label: "Delete", divider: true, danger: true, onSelect: () => setDeleting(p) },
                      ]}
                    >
                      <button type="button" className="folder-card" onClick={() => setOpenId(p.id)}>
                        <span className="folder-ico">
                          <FolderIcon color={p.color} size={26} />
                        </span>
                        <span className="folder-text">
                          <strong>{p.name}</strong>
                          <small>
                            {p.file_count} {p.file_count === 1 ? "file" : "files"} · {p.chat_count} {p.chat_count === 1 ? "chat" : "chats"}
                          </small>
                        </span>
                      </button>
                    </ContextMenu>
                  ))}
                </div>
              ) : (
                <Empty icon={<IconFolder size={22} />} title={projects.length ? "No folders match" : "No folders yet"}>
                  {!projects.length && <SideFolder className="files-empty-art" />}
                  {projects.length ? "Try a different filter or search." : "Create a folder to group related chats and files."}
                </Empty>
              )}
            </section>

            <section aria-labelledby="files-h">
              <div className="section-bar">
                <h2 id="files-h" className="eyebrow">
                  Recent files <span>{shownFiles.length}</span>
                </h2>
              </div>
              <div className="toolbar">
                <div className="seg" role="group" aria-label="Filter by type">
                  <button type="button" aria-pressed={typeFilter === "all"} onClick={() => setTypeFilter("all")}>
                    All
                  </button>
                  {kinds.map((k) => (
                    <button key={k} type="button" aria-pressed={typeFilter === k} onClick={() => setTypeFilter(k)}>
                      {KIND_LABEL[k] ?? k}
                    </button>
                  ))}
                </div>
                <span className="grow" />
                <label className="search-input">
                  <IconSearch size={14} />
                  <input name="file-search" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} placeholder="Search files…" aria-label="Search files" />
                </label>
                {fileInput}
                <button type="button" className="btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
                  <IconUpload size={14} /> {uploading ? "Uploading…" : "Upload file"}
                </button>
              </div>
              {filesBody}
            </section>
          </>
        )}
      </div>

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <IconUpload size={22} /> Drop text files to upload{folder ? ` to ${folder.name}` : ""}
        </div>
      )}

      <Dialog
        open={creating || !!renaming}
        onClose={() => {
          setCreating(false);
          setRenaming(null);
        }}
        title={renaming ? "Rename folder" : "Create folder"}
        width={380}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setCreating(false);
                setRenaming(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void (renaming ? renameFolder() : createFolder())} disabled={!name.trim() || busy}>
              {renaming ? "Save" : "Create"}
            </button>
          </>
        }
      >
        <label className="field-label" htmlFor="folder-name">
          Folder name
        </label>
        <input
          id="folder-name"
          className="input"
          value={name}
          maxLength={60}
          data-autofocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void (renaming ? renameFolder() : createFolder())}
        />
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        danger
        busy={busy}
        title="Delete folder?"
        message={<>“{deleting?.name}” will be removed. Its chats and files are kept, just no longer in a folder.</>}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => void deleteFolder()}
      />

      <FilePreview
        file={preview}
        projects={projects}
        onClose={() => setPreview(null)}
        onOpenChat={(id) => {
          setPreview(null);
          onOpenChat(id);
        }}
        onChanged={() => {
          setPreview(null);
          void load();
          onChanged();
        }}
      />
    </div>
  );
}

function FilePreview({
  file,
  projects,
  onClose,
  onOpenChat,
  onChanged,
}: {
  file: FileRow | null;
  projects: Project[];
  onClose: () => void;
  onOpenChat: (id: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<(AttachmentRef & { content: string }) | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [folderId, setFolderId] = useState("");

  useEffect(() => {
    setData(null);
    setConfirm(false);
    setFolderId(file?.project_id ?? "");
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

  const move = async (id: string) => {
    if (!file) return;
    setFolderId(id);
    try {
      await api.moveFile(file.id, id || null);
      toast(id ? "Moved to folder" : "Removed from folder", "success");
      onChanged();
    } catch (e) {
      toast(`Couldn't move: ${errMsg(e)}`, "error");
      setFolderId(file.project_id ?? "");
    }
  };

  const del = async () => {
    if (!file) return;
    try {
      await api.deleteFile(file.id);
      toast("File deleted", "success");
      onChanged();
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
        <div className="preview-meta">
          <p className="small muted">{file && `${file.kind} · ${fmtBytes(file.size)} · added ${relTime(file.created_at)}`}</p>
          <label className="small muted preview-folder">
            Folder
            <select className="select-sm" value={folderId} onChange={(e) => void move(e.target.value)} aria-label="Move to folder">
              <option value="">None</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {data ? <pre className="file-pre">{data.content}</pre> : <div className="loading-row"><Spinner /></div>}
      </Dialog>
      <ConfirmDialog open={!!file && confirm} danger title="Delete file?" message={<>“{file?.name}” will be permanently deleted.</>} confirmLabel="Delete" onCancel={() => setConfirm(false)} onConfirm={() => void del()} />
    </>
  );
}
