import { useEffect, useMemo, useState } from "react";
import { api, type Delivery, type Integrations, type Preferences } from "../../api";
import { useToast } from "../../shell/toast";
import { Avatar, ConfirmDialog } from "../../shell/ui";
import { errMsg, initials, useStored, useTheme, type ThemePref } from "../../shell/util";
import { notificationPermission, requestNotificationPermission, setNotifyPrefs, testNotification } from "../../shell/notify";
import { Badge, Btn, Card, describeDevice, H2, Head, Ic, ImagePick, Notice, Row, Seg, Select, Switch, TextArea, TextInput, ToolTile, type Opt } from "./blocks";

export type PageProps = { prefs: Preferences; save: (p: Partial<Preferences>) => Promise<boolean> };

const ROLES = ["Engineer", "Designer", "Product", "Founder", "Marketing", "Sales", "Operations", "Research", "Student", "Other"];

/* ── Profile ── */
export function ProfilePage({ prefs, save }: PageProps) {
  const toast = useToast();
  const [, setName] = useStored<string>("minimi.name", "You");
  const [avatar, setAvatar] = useStored<string>("minimi.avatar", "");
  const [, setTz] = useStored<string>("minimi.tz", "");

  const saveName = async (first: string, last: string) => {
    const f = first.trim();
    const l = last.trim();
    const full = [f, l].filter(Boolean).join(" ");
    if (await save({ firstName: f, lastName: l, displayName: full })) setName(full || "You");
  };
  const zones = useMemo<Opt[]>(() => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let all: string[] = [];
    try {
      all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      /* older browsers */
    }
    if (!all.includes(browser)) all = [browser, ...all];
    return [{ value: "", label: `Browser default (${browser})` }, ...all.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))];
  }, []);
  const displayName = prefs.displayName || "You";

  return (
    <>
      <Head title="Profile" sub="Manage your personal details." />
      <Notice>Your profile lives on this device. The assistant uses it to tailor answers; it is never shared.</Notice>
      <Card>
        <Row title="Profile picture" desc="PNG, JPEG, GIF or WebP, under 512 KB">
          <Avatar text={initials(displayName)} size={32} tone="accent" src={avatar || undefined} />
          <ImagePick onPick={setAvatar} onError={(m) => toast(m, "error")}>
            <Btn><Ic n="upload" size={13} /> Upload</Btn>
          </ImagePick>
          {avatar && <Btn variant="ghost" onClick={() => setAvatar("")}>Remove</Btn>}
        </Row>
        <Row title="First name">
          <TextInput label="First name" value={prefs.firstName} maxLength={60} placeholder="First name" onCommit={(v) => saveName(v, prefs.lastName)} />
        </Row>
        <Row title="Last name">
          <TextInput label="Last name" value={prefs.lastName} maxLength={60} placeholder="Last name" onCommit={(v) => saveName(prefs.firstName, v)} />
        </Row>
        <Row title="Role" desc="Helps tailor suggestions to your work">
          <Select label="Role" value={prefs.role} placeholder="Choose your role" width={200} options={ROLES.map((r) => ({ value: r, label: r }))} onChange={(v) => void save({ role: v })} />
        </Row>
        <Row title="Email" desc="Stays on this device">
          <TextInput label="Email" type="email" value={prefs.email} maxLength={120} placeholder="you@example.com" onCommit={(v) => save({ email: v })} />
        </Row>
      </Card>

      <H2 sub="Used for dates and times in your chats and the assistant's answers.">Time preferences</H2>
      <Card>
        <Row title="Time zone" icon={<Ic n="globe" />}>
          <Select
            label="Time zone"
            value={prefs.timezone}
            width={250}
            options={zones}
            onChange={async (v) => {
              if (await save({ timezone: v })) setTz(v);
            }}
          />
        </Row>
      </Card>

      <H2 sub="Describe what you do and how you work, so the assistant can adapt to you.">Personal context</H2>
      <TextArea label="Personal context" value={prefs.personalContext} max={500} rows={4} placeholder="E.g. I lead product at a small team, prefer short answers and write in British English." onCommit={(v) => save({ personalContext: v })} />
    </>
  );
}

/* ── Preferences ── */
const MODEL_OPTS = [
  { value: "auto", label: "Auto", desc: "Picks a fast or strong model per question" },
  { value: "main", label: "Main", desc: "The default model every time" },
  { value: "fast", label: "Fast", desc: "Quickest answers, lighter reasoning" },
  { value: "smart", label: "Smart", desc: "Best for hard, multi-step questions" },
];

export function PreferencesPage({ prefs, save }: PageProps) {
  const toast = useToast();
  const [model, setModel] = useStored<string>("minimi.model", "auto");
  const [theme, setTheme] = useTheme();
  const [ints, setInts] = useState<Integrations | null>(null);
  useEffect(() => void api.integrations().then(setInts).catch(() => {}), []);
  const modelValue = MODEL_OPTS.some((m) => m.value === model) ? model : "auto";
  const short = (id?: string) => (id ? id.split("/").pop() : undefined);
  const named = (v: string) => (v === "main" ? short(ints?.llm.mainModel) : v === "fast" ? short(ints?.llm.fastModel) : v === "smart" ? short(ints?.llm.smartModel) : undefined);

  return (
    <>
      <Head title="Preferences" sub="Make the assistant work the way you do." />

      <H2>Models</H2>
      <Card>
        <Row title="Default model" desc={`Picked whenever you start a new chat · ${MODEL_OPTS.find((m) => m.value === modelValue)!.desc}`}>
          <Select
            label="Default model"
            value={modelValue}
            width={190}
            options={MODEL_OPTS.map((m) => ({ value: m.value, label: named(m.value) ? `${m.label} · ${named(m.value)}` : m.label }))}
            onChange={(v) => {
              setModel(v);
              toast("Applies to new chats", "info");
            }}
          />
        </Row>
      </Card>

      <Card>
        <Row title="Language" desc="For menus and the assistant's answers. English only for now.">
          <Select label="Language" value="en" disabled width={150} icon={<Ic n="globe" />} options={[{ value: "en", label: "English" }]} onChange={() => {}} />
        </Row>
        <Row title="Appearance" desc={theme === "system" ? "System follows your device" : `Always ${theme}`}>
          <Seg<ThemePref>
            label="Appearance"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System", icon: <Ic n="monitor" size={12} /> },
              { value: "light", label: "Light", icon: <Ic n="sun" size={12} /> },
              { value: "dark", label: "Dark", icon: <Ic n="moon" size={12} /> },
            ]}
          />
        </Row>
      </Card>

      <H2 sub="Extra tools for your own chats.">Chat tools</H2>
      <div className="st-tiles">
        <ToolTile icon={<Ic n="globe" size={15} />} title="Web search" desc="Looks things up when it needs fresh facts" checked={prefs.webSearch} onChange={(v) => void save({ webSearch: v })} />
        <ToolTile icon={<Ic n="memory" size={15} />} title="Memory" desc="Remembers and recalls what you asked on earlier days" checked={prefs.memoryRecall} onChange={(v) => void save({ memoryRecall: v })} />
      </div>

      <H2 sub="Added to every message you send, so you don't have to repeat yourself.">Custom instructions</H2>
      <Card>
        <Row title="Use my instructions" desc="Turn off to pause them without deleting the text.">
          <Switch label="Use my instructions" checked={prefs.useInstructions} onChange={(v) => void save({ useInstructions: v })} />
        </Row>
      </Card>
      <TextArea label="Custom instructions" value={prefs.customInstructions} max={2000} rows={5} placeholder="e.g. I'm a backend engineer. Keep answers short and show sources." onCommit={(v) => save({ customInstructions: v })} />
    </>
  );
}

/* ── Notifications ── */
const DELIVERY: Opt[] = [
  { value: "browser", label: "Browser" },
  { value: "off", label: "Off" },
];

export function NotificationsPage({ prefs, save }: PageProps) {
  const toast = useToast();
  const [perm, setPerm] = useState(notificationPermission());

  const saveNotify = async (patch: Partial<Preferences>) => {
    const ok = await save(patch);
    if (ok) setNotifyPrefs({ ...prefs, ...patch });
    return ok;
  };
  const enable = async () => {
    const r = await requestNotificationPermission();
    setPerm(r);
    if (r === "denied") toast("Notifications are blocked. Allow them in your browser's site settings.", "error");
  };
  const status =
    perm === "unsupported" ? "This browser doesn't support desktop notifications." : perm === "granted" ? "Enabled. Alerts appear while this tab is in the background." : perm === "denied" ? "Blocked in your browser's site settings." : "Not enabled yet.";

  const types: { key: "notifyApprovals" | "notifyFinished" | "notifyFailed"; title: string; desc: string }[] = [
    { key: "notifyApprovals", title: "Approvals", desc: "The agent waits for your OK before it acts" },
    { key: "notifyFinished", title: "Finished runs", desc: "An answer you asked for is ready" },
    { key: "notifyFailed", title: "Failed runs", desc: "A run stopped with an error" },
  ];

  return (
    <>
      <Head title="Notifications" sub="Choose what you hear about and where." />

      <H2 sub="Alerts only fire while this tab is in the background.">On this device</H2>
      <Card>
        <Row title="Desktop notifications" desc={status}>
          {perm === "default" && <Btn variant="primary" onClick={() => void enable()}>Enable</Btn>}
          {perm === "granted" && <Badge tone="green">On</Badge>}
          {perm === "denied" && <Badge tone="amber">Blocked</Badge>}
        </Row>
        <Row title="Sound" desc="A soft chime when something needs you">
          <Switch label="Sound" checked={prefs.notifySound} onChange={(v) => void saveNotify({ notifySound: v })} />
        </Row>
        <Row title="Send a test" desc="See and hear what an alert looks like">
          <Btn onClick={() => void testNotification(prefs.notifySound)}>Send test</Btn>
        </Row>
      </Card>

      <H2 sub="Choose which events alert you.">Notification types</H2>
      <Card className="st-table">
        <div className="st-thead">
          <span>Notify me about</span>
          <span>Notify on</span>
        </div>
        {types.map((t) => (
          <Row key={t.key} title={t.title} desc={t.desc}>
            <Select
              label={`${t.title} delivery`}
              value={prefs[t.key]}
              width={130}
              icon={<Ic n="bell" />}
              options={DELIVERY}
              onChange={(v) => void saveNotify({ [t.key]: v as Delivery })}
            />
          </Row>
        ))}
      </Card>
    </>
  );
}

/* ── Privacy ── */
export function PrivacyPage() {
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | "delete" | "key">(null);
  const [busy, setBusy] = useState<null | "export" | "delete" | "key">(null);
  const dev = useMemo(() => describeDevice(navigator.userAgent), []);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const exportAll = async () => {
    setBusy("export");
    try {
      const url = URL.createObjectURL(await api.exportData());
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
      <Head title="Privacy" sub="Decide what you share and where you're signed in." />

      <H2 sub="Everything is stored in a local database on this device. Minimi has no ad partners and doesn't train models on your chats.">Data and storage</H2>
      <Card>
        <Row title="Export everything" desc="All chats, messages and the facts Minimi saved, as one JSON file.">
          <Btn disabled={busy === "export"} onClick={() => void exportAll()}>{busy === "export" ? "Preparing…" : "Export JSON"}</Btn>
        </Row>
        <Row title="Delete all chats and memory" desc="Removes every chat, saved answer and uploaded file. Folders, settings and keys stay.">
          <Btn variant="danger" onClick={() => setConfirm("delete")}>Delete…</Btn>
        </Row>
        <Row title="Remove saved search key" desc="Deletes the Tavily key stored by Minimi. Search falls back to the free provider.">
          <Btn variant="danger" onClick={() => setConfirm("key")}>Remove…</Btn>
        </Row>
      </Card>

      <H2 sub="Minimi has no accounts, so the only session is the browser you're using now.">Active sessions</H2>
      <Card>
        <Row icon={<Ic n="laptop" size={16} />} title={<>{dev.browser} on {dev.os} <Badge tone="green">This device</Badge></>} desc={`${tz} · ${location.host}`} />
      </Card>

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
