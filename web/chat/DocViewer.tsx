import { useEffect, useMemo, useState } from "react";
import { api, type SourceRef } from "../api";
import { Close, Copy, Download, FileIcon, Spinner } from "./icons";
import { copyText, renderMarkdown, slug } from "./markdown";

/** A document open in the right panel. `content` is set for inline docs (the answer); otherwise loaded by `fileId`. */
export type DocTab = { id: string; name: string; fileId?: string; content?: string; kind?: string };

const ext = (n: string) => n.split(".").pop()?.toLowerCase() ?? "";

/** Minimal RFC-4180 style parser: quotes, escaped quotes, CRLF, custom delimiter. */
export function parseCsv(src: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"') {
        if (src[i + 1] === '"') (cell += '"'), i++;
        else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) (row.push(cell), rows.push(row));
  return rows;
}

const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function Grid({ text, delim }: { text: string; delim: string }) {
  const rows = useMemo(() => parseCsv(text, delim).slice(0, 500), [text, delim]);
  const [sel, setSel] = useState<[number, number]>([0, 0]);
  const cols = Math.min(52, Math.max(1, ...rows.map((r) => r.length)));
  const cur = rows[sel[0]]?.[sel[1]] ?? "";
  return (
    <div className="dv__sheet">
      <div className="dv__fx">
        <span className="dv__cellref">{colName(sel[1])}{sel[0] + 1}</span>
        <span className="dv__fxl">fx</span>
        <span className="dv__fxv" title={cur}>{cur}</span>
      </div>
      <div className="dv__gridwrap" role="grid" aria-label="Spreadsheet preview">
        <table className="dv__grid">
          <thead>
            <tr>
              <th />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} data-on={sel[1] === c || undefined}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                <th data-on={sel[0] === ri || undefined}>{ri + 1}</th>
                {Array.from({ length: cols }, (_, c) => (
                  <td
                    key={c}
                    role="gridcell"
                    data-head={ri === 0 || undefined}
                    data-sel={(sel[0] === ri && sel[1] === c) || undefined}
                    onClick={() => setSel([ri, c])}
                    title={r[c]}
                  >
                    {r[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Body({ tab, text, sources }: { tab: DocTab; text: string; sources: SourceRef[] }) {
  const e = ext(tab.name);
  if (e === "csv" || e === "tsv") return <Grid text={text} delim={e === "tsv" ? "\t" : ","} />;
  if (e === "md" || e === "markdown")
    return <div className="md dv__md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text, sources) }} />;
  return <pre className="dv__pre">{text}</pre>;
}

export function DocViewer({
  tabs,
  activeId,
  onSelect,
  onClose,
  sources,
  toast,
}: {
  tabs: DocTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  sources: SourceRef[];
  toast: (m: string, k?: "info" | "error" | "success") => void;
}) {
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const [loaded, setLoaded] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const need = tab.content === undefined && tab.fileId && loaded[tab.id] === undefined;

  useEffect(() => {
    setErr(null);
    if (!need) return;
    let live = true;
    api
      .getFile(tab.fileId!)
      .then((f) => live && setLoaded((m) => ({ ...m, [tab.id]: f.content })))
      .catch((e) => live && setErr(e instanceof Error ? e.message : "Couldn't open this file"));
    return () => {
      live = false;
    };
  }, [tab.id, tab.fileId, need]);

  const text = tab.content ?? loaded[tab.id];
  const copy = async () => {
    if (text === undefined) return;
    const ok = await copyText(text);
    toast(ok ? "Copied" : "Couldn't copy", ok ? "success" : "error");
  };
  const download = () => {
    if (text === undefined) return;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = tab.name.includes(".") ? tab.name : `${slug(tab.name)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="dv">
      <div className="dv__tabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} className="dv__tab" role="presentation" data-active={t.id === tab.id || undefined}>
            <button type="button" role="tab" aria-selected={t.id === tab.id} onClick={() => onSelect(t.id)} title={t.name}>
              <FileIcon />
              <span>{t.name}</span>
            </button>
            <button type="button" className="dv__x" aria-label={`Close ${t.name}`} onClick={() => onClose(t.id)}>
              <Close size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="dv__head">
        <span className="dv__ficon"><FileIcon /></span>
        <div className="dv__fmeta">
          <strong title={tab.name}>{tab.name}</strong>
          <small>{ext(tab.name).toUpperCase() || "TXT"}{text !== undefined ? ` · ${text.length.toLocaleString()} chars` : ""}</small>
        </div>
        <button type="button" className="icon-btn" aria-label="Copy" disabled={text === undefined} onClick={() => void copy()}><Copy /></button>
        <button type="button" className="icon-btn" aria-label="Download" disabled={text === undefined} onClick={download}><Download /></button>
      </div>
      <div className="dv__body" role="tabpanel">
        {err ? (
          <p className="rp__empty">{err}</p>
        ) : text === undefined ? (
          <p className="rp__empty"><Spinner size={13} /> Loading…</p>
        ) : text.trim() === "" ? (
          <p className="rp__empty">This file is empty.</p>
        ) : (
          <Body tab={tab} text={text} sources={sources} />
        )}
      </div>
    </div>
  );
}
