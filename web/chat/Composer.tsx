import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type AttachmentRef, type Integrations } from "../api";
import { DropdownMenu } from "../shell/DropdownMenu";
import type { ChatSettings, Toast } from "./types";
import { ArrowUp, Chevron, Close, FileIcon, Mic, Paperclip, Plus, Spinner, StopSquare } from "./icons";

const MAX_BYTES = 500_000;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ts|tsx|js|jsx|mjs|py|go|rs|java|c|h|cpp|html|css|sql|sh|yml|yaml|xml|toml|ini|env)$/i;
const ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.log,.ts,.tsx,.js,.jsx,.mjs,.py,.go,.rs,.java,.c,.h,.cpp,.html,.css,.sql,.sh,.yml,.yaml,.xml,.toml,.ini,text/*";

type Att = { localId: string; name: string; status: "uploading" | "done" | "error"; ref?: AttachmentRef; error?: string };

interface Props {
  streaming: boolean;
  hasMessages: boolean;
  conversationId: string | undefined;
  integrations: Integrations | null;
  settings: ChatSettings;
  setSettings: (s: ChatSettings) => void;
  focusToken: number;
  onSend: (text: string, atts: AttachmentRef[]) => boolean;
  onStop: () => void;
  toast: Toast;
}

const SR: any = typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

export function Composer({ streaming, hasMessages, conversationId, integrations, settings, setSettings, focusToken, onSend, onStop, toast }: Props) {
  const [text, setText] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recRef = useRef<any>(null);
  const baseText = useRef("");

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (focusToken > 0) ta.current?.focus();
  }, [focusToken]);

  useEffect(() => () => recRef.current?.abort?.(), []);

  const uploading = atts.some((a) => a.status === "uploading");
  const ready = atts.filter((a): a is Att & { ref: AttachmentRef } => a.status === "done" && !!a.ref);
  const canSend = text.trim().length > 0 && !streaming && !uploading;

  const submit = useCallback(() => {
    if (!canSend) return;
    recRef.current?.stop?.();
    if (onSend(text, ready.map((a) => a.ref))) {
      setText("");
      setAtts([]);
    }
  }, [canSend, onSend, text, ready]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  };

  /* ── Attachments ── */
  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const reject = (msg: string) => toast(`${file.name}: ${msg}`, "error");
      if (file.size > MAX_BYTES) { reject("too large (max 500 KB)"); continue; }
      if (!TEXT_EXT.test(file.name) && !file.type.startsWith("text/") && file.type !== "application/json") { reject("only text files are supported"); continue; }
      setAtts((a) => [...a, { localId, name: file.name, status: "uploading" }]);
      try {
        const content = await file.text();
        if (!content.trim()) throw new Error("file is empty");
        const ref = await api.uploadFile({ name: file.name, mime: file.type || undefined, content, conversationId });
        setAtts((a) => a.map((x) => (x.localId === localId ? { ...x, status: "done", ref } : x)));
      } catch (e) {
        const msg = e instanceof Error ? e.message : "upload failed";
        setAtts((a) => a.filter((x) => x.localId !== localId));
        reject(msg);
      }
    }
  };

  const removeAtt = (a: Att) => {
    setAtts((list) => list.filter((x) => x.localId !== a.localId));
    if (a.ref) void api.deleteFile(a.ref.id).catch(() => {});
  };

  /* ── Dictation ── */
  const toggleMic = () => {
    if (!SR) return;
    if (recording) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    baseText.current = text && !/\s$/.test(text) ? `${text} ` : text;
    rec.onresult = (ev: any) => {
      let finals = "";
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finals += r[0].transcript;
        else interim += r[0].transcript;
      }
      setText(baseText.current + finals + interim);
    };
    rec.onerror = (ev: any) => {
      const code = String(ev.error);
      if (code === "not-allowed" || code === "service-not-allowed") toast("Microphone access was blocked. Allow it in your browser settings.", "error");
      else if (code !== "aborted" && code !== "no-speech") toast(`Dictation stopped (${code}).`, "error");
    };
    rec.onend = () => {
      setRecording(false);
      recRef.current = null;
      ta.current?.focus();
    };
    try {
      rec.start();
      recRef.current = rec;
      setRecording(true);
    } catch {
      toast("Couldn't start dictation.", "error");
    }
  };

  const modelLabel = ({ auto: "Auto", main: "Main", fast: "Fast", smart: "Smart" } as const)[settings.model];
  const modelName = (m: "auto" | "main" | "fast" | "smart") =>
    !integrations
      ? ""
      : m === "fast"
        ? integrations.llm.fastModel
        : m === "smart"
          ? integrations.llm.smartModel ?? integrations.llm.mainModel
          : integrations.llm.mainModel;
  const short = (s: string) => s.split("/").pop() ?? s;

  const pick = (m: ChatSettings["model"]) => setSettings({ ...settings, model: m });

  const modelItems = (
    [
      ["auto", "Auto", integrations ? short(modelName("auto")) : "Best available model"],
      ["main", "Main", integrations ? short(modelName("main")) : "Most capable"],
      ["smart", "Smart", integrations ? short(modelName("smart")) + " · slower, best reasoning" : "Slower, best reasoning"],
      ["fast", "Fast", integrations ? short(modelName("fast")) : "Quicker, lighter"],
    ] as const
  ).map(([m, title, sub]) => ({
    label: title,
    description: sub,
    checked: settings.model === m,
    type: "radio" as const,
    onSelect: () => pick(m),
  }));

  return (
    <form
      className="cp"
      data-dragging={dragging ? "" : undefined}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer.files); } }}
    >
      {atts.length > 0 && (
        <ul className="cp__atts" aria-label="Attachments">
          {atts.map((a) => (
            <li key={a.localId} className="cp__att" data-status={a.status}>
              {a.status === "uploading" ? <Spinner size={12} /> : <FileIcon />}
              <span className="cp__attname">{a.name}</span>
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => removeAtt(a)}><Close size={12} /></button>
            </li>
          ))}
        </ul>
      )}

      <label className="sr-only" htmlFor="cp-input">Message</label>
      <textarea
        id="cp-input"
        ref={ta}
        rows={1}
        value={text}
        placeholder={hasMessages ? "Reply…" : "Ask anything…"}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const files = e.clipboardData.files;
          if (files.length) { e.preventDefault(); void addFiles(files); }
        }}
      />

      <div className="cp__bar">
        <div className="cp__left">
          <DropdownMenu
            side="top"
            align="start"
            width={280}
            aria-label="Add"
            items={[
              {
                label: "Attach text file",
                description: ".txt .md .csv .json and code, up to 500 KB",
                icon: <Paperclip />,
                onSelect: () => fileInput.current?.click(),
              },
            ]}
            trigger={({ triggerProps }) => (
              <button type="button" className="icon-btn" aria-label="Add" {...triggerProps}>
                <Plus />
              </button>
            )}
          />
          <input
            ref={fileInput}
            name="attachments"
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />

        </div>

        <div className="cp__right">
          <DropdownMenu
            side="top"
            align="end"
            width={260}
            aria-label="Model"
            items={modelItems}
            trigger={({ open, triggerProps }) => (
              <button type="button" className="model-btn" aria-label={`Model: ${modelLabel}`} {...triggerProps}>
                {modelLabel}
                <Chevron size={12} data-open={open || undefined} />
              </button>
            )}
          />

          <button
            type="button"
            className="icon-btn"
            data-recording={recording ? "" : undefined}
            aria-label={recording ? "Stop dictation" : "Dictate"}
            aria-pressed={recording}
            disabled={!SR}
            title={SR ? (recording ? "Stop dictation" : "Dictate with your microphone") : "Dictation isn't supported in this browser"}
            onClick={toggleMic}
          >
            <Mic />
          </button>

          {streaming ? (
            <button type="button" className="send send--stop" aria-label="Stop" onClick={onStop}>
              <StopSquare />
            </button>
          ) : (
            <button type="submit" className="send" aria-label="Send" disabled={!canSend}>
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
