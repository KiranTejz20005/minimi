import { useEffect, useState, type ReactNode } from "react";
import { api, type Integrations } from "../api";
import { IconCheck, IconX } from "./icons";
import { useToast } from "./toast";
import { Dialog, Spinner } from "./ui";
import { errMsg, fmtMs } from "./util";

/* Callers: App.tsx Integrations dialog. Brand marks + cleaner layout. User: improve UI, realistic icons. */

type TestState = { busy: boolean; ok?: boolean; ms?: number; text?: string } | undefined;

/** NVIDIA eye mark (brand green via currentColor). */
function NvidiaMark() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.2 16.7c.2.2.5.3.8.2 2.4-.8 4.4-2.5 5.6-4.8.1-.2 0-.5-.2-.6-.2-.1-.5 0-.6.2-1 2-2.8 3.5-4.9 4.2-.3.1-.5.4-.3.7l-.4.1zm8.6-9.1c-.2-.3-.6-.4-.9-.2-3.4 2.1-5.6 5.7-5.9 9.7 0 .3.2.6.5.6h.1c.3 0 .5-.2.6-.5.3-3.5 2.2-6.7 5.2-8.5.3-.2.4-.6.4-1.1zm-14 .9C3.2 10.7 2.5 13 2.5 15.4c0 .3.3.6.6.6h.1c.3 0 .6-.2.6-.5.1-1.9.7-3.7 1.7-5.3.1-.2.1-.5-.1-.7-.2-.2-.5-.2-.7 0l-.3.1zM12 4.2c-4.3 0-8 2.8-9.4 6.8-.1.3 0 .6.3.7.3.1.6 0 .7-.3C4.8 7.8 8.1 5.4 12 5.4c3.9 0 7.2 2.4 8.4 5.9.1.3.4.4.7.3.3-.1.4-.4.3-.7C19.9 7 16.3 4.2 12 4.2zm0 2.5c-3.2 0-6 2.1-7 5.2-.1.3 0 .6.3.7.3.1.6 0 .7-.3.8-2.5 3.1-4.2 5.9-4.2s5.1 1.7 5.9 4.2c.1.3.4.4.7.3.3-.1.4-.4.3-.7-1-3.1-3.8-5.2-7-5.2z"
      />
    </svg>
  );
}

/** Tavily wordmark “T” — product indigo. */
function TavilyMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.8 5h16.4c.7 0 1.2.5 1.2 1.2v1.4c0 .7-.5 1.2-1.2 1.2h-6.2v10c0 .7-.5 1.2-1.2 1.2H11c-.7 0-1.2-.5-1.2-1.2v-10H3.8c-.7 0-1.2-.5-1.2-1.2V6.2C2.6 5.5 3.1 5 3.8 5z"
      />
    </svg>
  );
}

function providerLogo(kind: "llm" | "search", name: string): { node: ReactNode; tone: string } {
  const n = name.toLowerCase();
  if (kind === "llm") {
    if (n.includes("nvidia") || n.includes("nim")) return { node: <NvidiaMark />, tone: "nvidia" };
    if (n.includes("anthropic") || n.includes("claude"))
      return {
        node: (
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M13.7 3.4 15.5 7c.2.5.9 1 1.4 1.1l3.2.5c2 .3 2.5 1.8 1.1 3.3l-2.5 2.5c-.4.4-.7 1.2-.5 1.8l.7 3.1c.6 2.4-.7 3.4-2.9 2.1l-3-1.8c-.5-.3-1.4-.3-2 0l-3 1.8c-2.1 1.3-3.4.3-2.8-2.1l.7-3.1c.1-.6-.1-1.4-.5-1.8L2.9 11.9C1.4 10.4 1.9 8.9 3.9 8.6l3.2-.5c.5-.1 1.2-.6 1.4-1.1l1.8-3.6c1-1.9 2.5-1.9 3.4 0z" />
          </svg>
        ),
        tone: "anthropic",
      };
    return {
      node: (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M12 2.5 4.5 6.5v11L12 21.5l7.5-4v-11L12 2.5zm0 2.3 5.2 2.8v8.8L12 19.2l-5.2-2.8V7.6L12 4.8z" />
        </svg>
      ),
      tone: "llm",
    };
  }
  if (n.includes("tavily")) return { node: <TavilyMark />, tone: "tavily" };
  return {
    node: (
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm7.5 9h-3.1a15 15 0 0 0-1.2-5 8 8 0 0 1 4.3 5zM12 4c.9 0 2.4 2.3 3.1 7H8.9C9.6 6.3 11.1 4 12 4zM4.5 11a8 8 0 0 1 4.3-5 15 15 0 0 0-1.2 5H4.5zm0 2h3.1a15 15 0 0 0 1.2 5 8 8 0 0 1-4.3-5zM12 20c-.9 0-2.4-2.3-3.1-7h6.2c-.7 4.7-2.2 7-3.1 7zm4.1-2a15 15 0 0 0 1.2-5h3.1a8 8 0 0 1-4.3 5z" />
      </svg>
    ),
    tone: "search",
  };
}

function shortModel(id: string) {
  const leaf = id.split("/").pop() ?? id;
  return leaf.length > 36 ? `${leaf.slice(0, 34)}…` : leaf;
}

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
  const llmLogo = llm ? providerLogo("llm", llm.provider) : null;
  const searchLogo = search ? providerLogo("search", search.provider) : null;

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
    <Dialog open={open} onClose={onClose} title="Integrations" width={520}>
      {!integrations ? (
        <div className="dialog-loading">
          <Spinner />
        </div>
      ) : (
        <div className="int-list">
          <section className="int-card" aria-labelledby="int-llm">
            <header className="int-card__head">
              <span className="int-logo" data-tone={llmLogo!.tone}>
                {llmLogo!.node}
              </span>
              <div className="int-title">
                <h3 id="int-llm">{llm!.provider}</h3>
                <p>Language model</p>
              </div>
              <span className="status" data-ok={llm!.connected}>
                <i /> {llm!.connected ? "Connected" : "No key"}
              </span>
            </header>

            <ul className="int-models">
              <li>
                <span className="int-models__role">Main</span>
                <code title={llm!.mainModel}>{shortModel(llm!.mainModel)}</code>
              </li>
              <li>
                <span className="int-models__role">Fast</span>
                <code title={llm!.fastModel}>{shortModel(llm!.fastModel)}</code>
              </li>
              {llm!.smartModel && (
                <li>
                  <span className="int-models__role">Smart</span>
                  <code title={llm!.smartModel}>{shortModel(llm!.smartModel)}</code>
                </li>
              )}
            </ul>

            <footer className="int-card__foot">
              <p className="int-note">API key and models are set in the server <code>.env</code>.</p>
              <div className="int-actions">
                <button type="button" className="btn" onClick={() => test("llm")} disabled={tests.llm?.busy}>
                  {tests.llm?.busy ? "Testing…" : "Test connection"}
                </button>
                {result(tests.llm)}
              </div>
            </footer>
          </section>

          <section className="int-card" aria-labelledby="int-search">
            <header className="int-card__head">
              <span className="int-logo" data-tone={searchLogo!.tone}>
                {searchLogo!.node}
              </span>
              <div className="int-title">
                <h3 id="int-search">{search!.provider}</h3>
                <p>Web search</p>
              </div>
              <span className="status" data-ok={search!.connected}>
                <i /> {search!.connected ? "Ready" : "Unavailable"}
              </span>
            </header>

            <p className="int-note int-note--flush">
              {search!.hasTavilyKey
                ? "Using your saved Tavily key for fresher results."
                : "No key yet — falling back to keyless search. Add a Tavily key for better results."}
            </p>

            <form
              className="int-keyrow"
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void saveKey(key.trim());
              }}
            >
              <label className="int-keyrow__lab" htmlFor="tavily-key">
                API key
              </label>
              <div className="int-keyrow__fields">
                <input
                  id="tavily-key"
                  name="tavily-key"
                  type="password"
                  className="input int-keyrow__input"
                  placeholder={search!.hasTavilyKey ? "••••••••••••  paste to replace" : "tvly-…"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className="btn btn-primary" disabled={!key.trim() || saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
                {search!.hasTavilyKey && (
                  <button type="button" className="btn" disabled={saving} onClick={() => void saveKey("")}>
                    Remove
                  </button>
                )}
              </div>
            </form>

            <footer className="int-card__foot">
              <div className="int-actions">
                <button type="button" className="btn" onClick={() => test("search")} disabled={tests.search?.busy}>
                  {tests.search?.busy ? "Testing…" : "Test search"}
                </button>
                {result(tests.search)}
              </div>
            </footer>
          </section>

          <p className="int-foot">Time zone: {integrations.timezone}</p>
        </div>
      )}
    </Dialog>
  );
}
