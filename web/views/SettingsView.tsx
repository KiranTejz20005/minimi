import { useCallback, useEffect, useRef, useState } from "react";
import "./settings.css";
import { api, type Preferences } from "../api";
import { useToast } from "../shell/toast";
import { Avatar } from "../shell/ui";
import { errMsg, initials, useStored } from "../shell/util";
import { Btn, Ic } from "./settings/blocks";
import { NotificationsPage, PreferencesPage, PrivacyPage, ProfilePage } from "./settings/personal";
import { BillingPage, GeneralPage, MembersPage, ModelsPage, SecurityPage } from "./settings/workspace";

/* Settings route (App.tsx, id "settings", URL /app/settings/<section>).
   Every control is wired to something real: GET/PUT /api/preferences (profile, workspace, chat tools, notifications),
   localStorage mirrors for what other screens read instantly (name, avatar, workspace, time zone, model, theme),
   plus the data actions (export, delete, remove key). Pages with nothing real to configure say so instead of faking it. */

export type SettingsSection = "profile" | "preferences" | "notifications" | "privacy" | "general" | "members" | "models" | "security" | "billing";

const GROUPS: { label: string; items: { id: SettingsSection; label: string; icon: string }[] }[] = [
  {
    label: "Personal",
    items: [
      { id: "profile", label: "Profile", icon: "user" },
      { id: "preferences", label: "Preferences", icon: "sliders" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "privacy", label: "Privacy", icon: "shield" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "general", label: "General", icon: "cog" },
      { id: "members", label: "Members", icon: "users" },
      { id: "models", label: "Models", icon: "cube" },
      { id: "security", label: "Security", icon: "lock" },
      { id: "billing", label: "Billing", icon: "card" },
    ],
  },
];
const IDS = GROUPS.flatMap((g) => g.items.map((i) => i.id));

export type SettingsViewProps = {
  section?: string;
  onSection?: (s: string) => void;
  onBack?: () => void;
};

export function SettingsView({ section, onSection, onBack }: SettingsViewProps) {
  const toast = useToast();
  const [local, setLocal] = useState<SettingsSection>("preferences");
  const wanted = section ?? local;
  const active: SettingsSection = (IDS as string[]).includes(wanted) ? (wanted as SettingsSection) : "preferences";
  const go = (s: SettingsSection) => {
    setLocal(s);
    onSection?.(s);
  };

  const [name] = useStored<string>("minimi.name", "You");
  const [avatar] = useStored<string>("minimi.avatar", "");

  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadErr(null);
    api.preferences().then(setPrefs).catch((e) => setLoadErr(errMsg(e)));
  }, []);
  useEffect(load, [load]);

  // "Saved" flash: shown briefly after every successful save.
  const [flash, setFlash] = useState(0);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** Saves a patch; the UI updates first and rolls back with a message if the server refuses it. */
  const save = useCallback(
    async (patch: Partial<Preferences>): Promise<boolean> => {
      const before = prefsRef.current;
      setPrefs((p) => (p ? { ...p, ...patch } : p));
      try {
        setPrefs(await api.setPreferences(patch));
        setFlash((n) => n + 1);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash(0), 1600);
        return true;
      } catch (e) {
        setPrefs(before);
        toast(`Couldn't save: ${errMsg(e)}`, "error");
        return false;
      }
    },
    [toast],
  );

  const openSearch = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

  const page = () => {
    if (!prefs) return null;
    const p = { prefs, save };
    switch (active) {
      case "profile": return <ProfilePage {...p} />;
      case "notifications": return <NotificationsPage {...p} />;
      case "privacy": return <PrivacyPage />;
      case "general": return <GeneralPage {...p} />;
      case "members": return <MembersPage {...p} />;
      case "models": return <ModelsPage />;
      case "security": return <SecurityPage />;
      case "billing": return <BillingPage />;
      default: return <PreferencesPage {...p} />;
    }
  };

  return (
    <div className="st-view">
      <nav className="st-nav" aria-label="Settings">
        <div className="st-navtop">
          <button type="button" className="st-back" onClick={onBack} disabled={!onBack}>
            <Ic n="chevL" size={13} />
            <span>Settings</span>
          </button>
          <button type="button" className="st-search" onClick={openSearch} aria-label="Search chats and commands">
            <Ic n="search" size={13} />
            <span>Search…</span>
            <kbd>{mod}</kbd>
          </button>
        </div>
        <div className="st-navscroll">
          {GROUPS.map((g) => (
            <div key={g.label} className="st-group">
              <p className="st-grouplabel">{g.label}</p>
              {g.items.map((i) => (
                <button key={i.id} type="button" className="st-navitem" aria-current={active === i.id ? "page" : undefined} onClick={() => go(i.id)}>
                  <Ic n={i.icon} />
                  {i.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <button type="button" className="st-user" onClick={() => go("profile")} aria-label="Your profile">
          <Avatar text={initials(name)} size={22} tone="accent" src={avatar || undefined} />
          <span>{name}</span>
          <Ic n="chevD" size={12} />
        </button>
      </nav>

      <main className="st-main">
        <span className="st-saved" data-show={flash > 0 || undefined} role="status" aria-live="polite">
          {flash > 0 && (<><Ic n="check" size={12} /> Saved</>)}
        </span>
        <div className="st-col">
          {loadErr ? (
            <div className="st-error" role="alert">
              <p>Couldn't load your settings: {loadErr}</p>
              <Btn onClick={load}>Retry</Btn>
            </div>
          ) : !prefs ? (
            <div className="st-skel" aria-busy="true" aria-label="Loading settings">
              <i style={{ width: "34%", height: 22 }} />
              <i style={{ width: "58%" }} />
              <i style={{ height: 150, marginTop: 18 }} />
              <i style={{ height: 96 }} />
            </div>
          ) : (
            <div key={active} className="st-page">{page()}</div>
          )}
        </div>
      </main>
    </div>
  );
}
