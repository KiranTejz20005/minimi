import { useEffect, useState } from "react";
import { api, type Integrations } from "../api";
import { IconCheck, IconGlobe, IconSparkle, IconX } from "./icons";
import { useToast } from "./toast";
import { Dialog, Spinner } from "./ui";
import { errMsg, fmtMs } from "./util";

type TestState = { busy: boolean; ok?: boolean; ms?: number; text?: string } | undefined;

export function IntegrationsModal({
  open,
  onClose,
  integrations,
  onUpdated,
}: {
  open: boolean;
  onClose: () => void;
  integrations: Integrations | null;
  onUpdated: (i: Integrations) => void;
}) {
  const toast = useToast();
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  useEffect(() => {
    if (open) {
      setKey("");
      setTests({});
      api.integrations().then(onUpdated).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const test = async (target: "llm" | "search") => {
    setTests((t) => ({ ...t, [target]: { busy: true } }));
    try {
      const r = await api.testIntegration(target);
      setTests((t) => ({ ...t, [target]: { busy: false, ok: r.ok, ms: r.ms, text: r.ok ? r.detail ?? "Connected" : r.error ?? "Failed" } }));
    } catch (e) {
      setTests((t) => ({ ...t, [target]: { busy: false, ok: false, text: errMsg(e) } }));
    }
  };

  const saveKey = async (value: string) => {
    setSaving(true);
    try {
      const next = await api.setTavilyKey(value);
      onUpdated(next);
      setKey("");
      setTests((t) => ({ ...t, search: undefined }));
      toast(value ? "Tavily key saved — web search now uses Tavily" : "Tavily key removed — using keyless web search", "success");
    } catch (e) {
      toast(`Couldn't save key: ${errMsg(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const llm = integrations?.llm;
  const search = integrations?.search;

  const result = (t: TestState) =>
    t && !t.busy ? (
      <p className="test-result" data-ok={t.ok} role="status">
        {t.ok ? <IconCheck size={14} /> : <IconX size={14} />}
        <span>
          {t.text}
          {t.ms != null && ` · ${fmtMs(t.ms)}`}
        </span>
      </p>
    ) : null;

  return (
    <Dialog open={open} onClose={onClose} title="Integrations" width={560}>
      {!integrations ? (
        <div className="dialog-loading">
          <Spinner />
        </div>
      ) : (
        <div className="int-list">
          <section className="int-card" aria-labelledby="int-llm">
            <header>
              <span className="int-logo">
                <IconSparkle />
              </span>
              <div className="int-title">
                <h3 id="int-llm">Language model</h3>
                <p>{llm!.provider}</p>
              </div>
              <span className="status" data-ok={llm!.connected}>
                <i /> {llm!.connected ? "Connected" : "No key"}
              </span>
            </header>
            <dl className="int-meta">
              <div>
                <dt>Main model</dt>
                <dd>{llm!.mainModel}</dd>
              </div>
              <div>
                <dt>Fast model</dt>
                <dd>{llm!.fastModel}</dd>
              </div>
            </dl>
            <p className="int-note">The API key is set on the server (.env). Models are changed there too.</p>
            <div className="int-actions">
              <button type="button" className="btn" onClick={() => test("llm")} disabled={tests.llm?.busy}>
                {tests.llm?.busy ? "Testing…" : "Test connection"}
              </button>
              {result(tests.llm)}
            </div>
          </section>

          <section className="int-card" aria-labelledby="int-search">
            <header>
              <span className="int-logo">
                <IconGlobe />
              </span>
              <div className="int-title">
                <h3 id="int-search">Web search</h3>
                <p>{search!.provider}</p>
              </div>
              <span className="status" data-ok={search!.connected}>
                <i /> {search!.connected ? "Ready" : "Unavailable"}
              </span>
            </header>
            <p className="int-note">
              {search!.hasTavilyKey
                ? "Using Tavily (key saved on this server)."
                : "No Tavily key — using keyless web search. Add a Tavily key for better, fresher results."}
            </p>
            <form
              className="key-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void saveKey(key.trim());
              }}
            >
              <label className="sr-only" htmlFor="tavily-key">
                Tavily API key
              </label>
              <input
                id="tavily-key"
                name="tavily-key"
                type="password"
                className="input"
                placeholder={search!.hasTavilyKey ? "•••••••••••• (saved) — paste to replace" : "tvly-… (optional)"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="btn btn-primary" disabled={!key.trim() || saving}>
                Save
              </button>
              {search!.hasTavilyKey && (
                <button type="button" className="btn" disabled={saving} onClick={() => void saveKey("")}>
                  Remove
                </button>
              )}
            </form>
            <div className="int-actions">
              <button type="button" className="btn" onClick={() => test("search")} disabled={tests.search?.busy}>
                {tests.search?.busy ? "Testing…" : "Test search"}
              </button>
              {result(tests.search)}
            </div>
          </section>

          <p className="int-foot">Time zone: {integrations.timezone}</p>
        </div>
      )}
    </Dialog>
  );
}
