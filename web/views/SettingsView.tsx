import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import "./settings.css";
import { api, type Preferences } from "../api";
import { useToast } from "../shell/toast";
import { ConfirmDialog } from "../shell/ui";
import { errMsg, useStored, useTheme, type ThemePref } from "../shell/util";

/* Settings route (App.tsx, id "settings"). Only settings that are wired to real behaviour live here:
   model + theme (localStorage, read by chat/App), name, custom instructions and web search (GET/PUT /api/preferences),
   and the privacy actions (GET /api/export, DELETE /api/data, PUT /api/integrations/tavily with ""). */

export type SettingsSection = "profile" | "preferences" | "privacy";
const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "preferences", label: "Preferences" },
  { id: "privacy", label: "Privacy" },
];
const MAX_INSTRUCTIONS = 2000;

export type SettingsViewProps = {
  /** "profile" | "preferences" | "privacy"; unknown values fall back to preferences */
  section?: string;
  onSection?: (s: string) => void;
  onBack?: () => void;
};

export function SettingsView({ section, onSection, onBack }: SettingsViewProps) {
  const toast = useToast();
  const [local, setLocal] = useState<SettingsSection>("preferences");
  const active: SettingsSection = SECTIONS.some((s) => s.id === (section ?? local)) ? ((section ?? local) as SettingsSection) : "preferences";
  const go = (s: SettingsSection) => {
    setLocal(s);
    onSection?.(s);
  };

  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadErr(null);
    api.preferences().then(setPrefs).catch((e) => setLoadErr(errMsg(e)));
  }, []);
  useEffect(load, [load]);

  /** Saves a patch; the UI updates first and rolls back with a message if the server refuses it. */
  const save = useCallback(
    async (patch: Partial<Preferences>): Promise<boolean> => {
      const before = prefs;
      setPrefs((p) => (p ? { ...p, ...patch } : p));
      try {
        setPrefs(await api.setPreferences(patch));
        return true;
      } catch (e) {
        setPrefs(before);
        toast(`Couldn't save: ${errMsg(e)}`, "error");
        return false;
      }
    },
    [prefs, toast],
  );

  return (
    <div className="view st-view">
      <nav className="st-nav" aria-label="Settings">
        {onBack && (
          <button type="button" className="st-back" onClick={onBack}>
            <span aria-hidden="true">‹</span> Settings
          </button>
        )}
        <p className="st-navgroup">Personal</p>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="st-navitem" aria-current={active === s.id ? "page" : undefined} onClick={() => go(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>

      <main className="st-main">
        {loadErr ? (
          <div className="st-error" role="alert">
            <p>Couldn't load your settings: {loadErr}</p>
            <button type="button" className="btn" onClick={load}>Retry</button>
          </div>
        ) : !prefs ? (
          <p className="st-muted" aria-busy="true">Loading settings…</p>
        ) : active === "profile" ? (
          <ProfileSection prefs={prefs} save={save} />
        ) : active === "privacy" ? (
          <PrivacySection />
        ) : (
          <PreferencesSection prefs={prefs} save={save} />
        )}
      </main>
    </div>
  );
}

/* ── Sections ── */

type SectionProps = { prefs: Preferences; save: (p: Partial<Preferences>) => Promise<boolean> };

function ProfileSection({ prefs, save }: SectionProps) {
  const toast = useToast();
  const [, setStoredName] = useStored<string>("minimi.name", "You");
  const [name, setName] = useState(prefs.displayName);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== prefs.displayName;

  const submit = async () => {
    setBusy(true);
    const ok = await save({ displayName: name });
    setBusy(false);
    if (!ok) return;
    // The sidebar reads this key; empty falls back to the default label.
    setStoredName(name.trim() || "You");
    window.dispatchEvent(new CustomEvent("minimi:name", { detail: name.trim() || "You" }));
    toast("Profile saved", "success");
  };

  return (
    <>
      <Head title="Profile" sub="How you appear in Minimi." />
      <Group>
        <Row title="Display name" desc="Shown in the sidebar and your account menu.">
          <form
            className="st-inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty && !busy) void submit();
            }}
          >
            <input className="input st-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} aria-label="Display name" placeholder="Your name" />
            <button type="submit" className="btn btn-primary" disabled={!dirty || busy}>Save</button>
          </form>
        </Row>
      </Group>
    </>
  );
}

const MODELS: { value: string; label: string; desc: string }[] = [
  { value: "auto", label: "Auto", desc: "Picks a fast or strong model per question" },
  { value: "main", label: "Main", desc: "The default model every time" },
  { value: "fast", label: "Fast", desc: "Quickest answers, lighter reasoning" },
  { value: "smart", label: "Smart", desc: "Best for hard, multi-step questions" },
];

function PreferencesSection({ prefs, save }: SectionProps) {
  const toast = useToast();
  const [model, setModel] = useStored<string>("minimi.model", "auto");
  const [theme, setTheme] = useTheme();
  const modelValue = MODELS.some((m) => m.value === model) ? model : "auto";
  const [text, setText] = useState(prefs.customInstructions);
  const [busy, setBusy] = useState(false);
  const dirty = text.trim() !== prefs.customInstructions;

  const saveText = async () => {
    setBusy(true);
    const ok = await save({ customInstructions: text });
    setBusy(false);
    if (ok) toast("Instructions saved", "success");
  };

  return (
    <>
      <Head title="Preferences" sub="Make the assistant work the way you do." />

      <h2 className="st-h2">Models</h2>
      <Group>
        <Row title="Default model" desc={MODELS.find((m) => m.value === modelValue)?.desc ?? ""}>
          <select
            className="input st-select"
            aria-label="Default model"
            value={modelValue}
            onChange={(e) => {
              setModel(e.target.value);
              toast("Applies to new chats", "info");
            }}
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </Row>
      </Group>

      <Group>
        <Row title="Appearance" desc="System follows your device.">
          <div className="seg" role="radiogroup" aria-label="Appearance">
            {(["system", "light", "dark"] as ThemePref[]).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={theme === t} aria-pressed={theme === t} onClick={() => setTheme(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </Row>
      </Group>

      <h2 className="st-h2">Chat tools</h2>
      <Group>
        <Row title="Web search" desc="Looks things up when it needs fresh facts. Off: the assistant answers from memory and what you say.">
          <Switch label="Web search" checked={prefs.webSearch} onChange={(v) => void save({ webSearch: v })} />
        </Row>
      </Group>

      <h2 className="st-h2">Custom instructions</h2>
      <p className="st-muted st-sub">Added to every message you send, so you don't have to repeat yourself.</p>
      <Group>
        <Row title="Use my instructions" desc="Turn off to pause them without deleting the text.">
          <Switch label="Use my instructions" checked={prefs.useInstructions} onChange={(v) => void save({ useInstructions: v })} />
        </Row>
        <div className="st-block">
          <label className="field-label" htmlFor="st-instr">What should the assistant know about you?</label>
          <textarea
            id="st-instr"
            className="input st-textarea"
            rows={6}
            maxLength={MAX_INSTRUCTIONS}
            value={text}
            placeholder="e.g. I'm a backend engineer. Keep answers short and show sources."
            onChange={(e) => setText(e.target.value)}
          />
          <div className="st-actions">
            <span className="st-muted">{text.length}/{MAX_INSTRUCTIONS}</span>
            <button type="button" className="btn btn-primary" disabled={!dirty || busy} onClick={() => void saveText()}>Save instructions</button>
          </div>
        </div>
      </Group>
    </>
  );
}

function PrivacySection() {
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | "delete" | "key">(null);
  const [busy, setBusy] = useState<null | "export" | "delete" | "key">(null);

  const exportAll = async () => {
    setBusy("export");
    try {
      const blob = await api.exportData();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `minimi-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      toast(`Export failed: ${errMsg(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const deleteAll = async () => {
    setBusy("delete");
    try {
      await api.deleteAllData();
      toast("All chats and memory deleted", "success");
      setConfirm(null);
      // Chat lists and counts are cached all over the app; a clean reload is the safe reset.
      window.setTimeout(() => window.location.assign("/app"), 600);
    } catch (e) {
      toast(`Couldn't delete: ${errMsg(e)}`, "error");
      setBusy(null);
    }
  };

  const clearKey = async () => {
    setBusy("key");
    try {
      await api.setTavilyKey("");
      toast("Search key removed", "success");
      setConfirm(null);
    } catch (e) {
      toast(`Couldn't remove the key: ${errMsg(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Head title="Privacy" sub="Your data lives on this device. Take it with you or remove it." />

      <h2 className="st-h2">Your data</h2>
      <Group>
        <Row title="Export everything" desc="All chats, messages and the facts Minimi saved, as one JSON file.">
          <button type="button" className="btn" disabled={busy === "export"} onClick={() => void exportAll()}>{busy === "export" ? "Preparing…" : "Export JSON"}</button>
        </Row>
        <Row title="Delete all chats and memory" desc="Removes every chat, saved answer and uploaded file. Folders, settings and keys stay.">
          <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirm("delete")}>Delete…</button>
        </Row>
      </Group>

      <h2 className="st-h2">Connections</h2>
      <Group>
        <Row title="Remove saved search key" desc="Deletes the Tavily key stored by Minimi. Search falls back to the free provider.">
          <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirm("key")}>Remove…</button>
        </Row>
      </Group>

      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete all chats and memory?"
        message="This permanently deletes every chat, the memory built from them, and uploaded files. It can't be undone. Export first if you might need them."
        confirmLabel="Delete everything"
        danger
        busy={busy === "delete"}
        onConfirm={() => void deleteAll()}
        onCancel={() => busy !== "delete" && setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "key"}
        title="Remove the saved search key?"
        message="You can add it again any time in Integrations."
        confirmLabel="Remove key"
        danger
        busy={busy === "key"}
        onConfirm={() => void clearKey()}
        onCancel={() => busy !== "key" && setConfirm(null)}
      />
    </>
  );
}

/* ── Building blocks ── */

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="st-head">
      <h1>{title}</h1>
      <p>{sub}</p>
    </header>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="st-group">{children}</div>;
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-rowtext">
        <strong>{title}</strong>
        {desc && <small>{desc}</small>}
      </div>
      <div className="st-ctl">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  const id = useId();
  return (
    <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label} className="st-switch" onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}
