import { useEffect, useState } from "react";
import { api, type Integrations, type Stats } from "../../api";
import { useToast } from "../../shell/toast";
import { Avatar, ConfirmDialog } from "../../shell/ui";
import { errMsg, fmtMs, initials, useStored } from "../../shell/util";
import { Badge, Btn, Card, H2, Head, Ic, ImagePick, Notice, Row, TextArea, TextInput } from "./blocks";
import type { PageProps } from "./personal";

const openIntegrations = () => window.dispatchEvent(new CustomEvent("minimi:open-integrations"));

function useIntegrations() {
  const [ints, setInts] = useState<Integrations | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    api.integrations().then(setInts).catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, []);
  return { ints, err, reload: load };
}

/* ── General ── */
export function GeneralPage({ prefs, save }: PageProps) {
  const toast = useToast();
  const [, setWs] = useStored<string>("minimi.workspace", "Minimi");
  const [icon, setIcon] = useStored<string>("minimi.wsicon", "");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const deleteAll = async () => {
    setBusy(true);
    try {
      await api.deleteAllData();
      toast("Workspace data deleted", "success");
      setConfirm(false);
      window.setTimeout(() => window.location.assign("/app"), 600);
    } catch (e) {
      toast(`Couldn't delete: ${errMsg(e)}`, "error");
      setBusy(false);
    }
  };

  return (
    <>
      <Head title="General" sub="Set up the basics of your workspace." />
      <Card>
        <Row title="Workspace icon" desc="Square, PNG or JPEG, up to 512 KB">
          <Avatar text={(prefs.workspaceName[0] ?? "M").toUpperCase()} size={32} tone="accent" src={icon || undefined} />
          <ImagePick onPick={setIcon} onError={(m) => toast(m, "error")}>
            <Btn><Ic n="upload" size={13} /> Upload</Btn>
          </ImagePick>
          {icon && <Btn variant="ghost" onClick={() => setIcon("")}>Remove</Btn>}
        </Row>
        <Row title="Workspace name" desc="Shown in the sidebar">
          <TextInput
            label="Workspace name"
            value={prefs.workspaceName}
            maxLength={40}
            placeholder="Minimi"
            onCommit={async (v) => {
              if (await save({ workspaceName: v })) setWs(v.trim());
            }}
          />
        </Row>
      </Card>

      <H2 sub="Added to every chat in this workspace, so the assistant already knows how your company works. Keep it short: it counts toward every message.">Company context</H2>
      <TextArea
        label="Company context"
        value={prefs.companyContext}
        max={2000}
        rows={6}
        placeholder="E.g. We have three business units: Sales, Operations and Finance. Common terms: CRM (customer relationship management), SLA (service level agreement)."
        onCommit={(v) => save({ companyContext: v })}
      />
      <p className="st-hint">Two or three short paragraphs work best: what the company does, how it's organised and the terms people use. Leave out slogans and history.</p>

      <H2 danger>Danger zone</H2>
      <Card>
        <Row title="Delete workspace data" desc={`All chats, memory and files in ${prefs.workspaceName || "this workspace"} go for good. Folders, settings and keys stay.`}>
          <Btn variant="danger" onClick={() => setConfirm(true)}><Ic n="trash" size={13} /> Delete workspace data</Btn>
        </Row>
      </Card>
      <ConfirmDialog
        open={confirm}
        title="Delete all workspace data?"
        message="This permanently deletes every chat, the memory built from them, and uploaded files. It can't be undone."
        confirmLabel="Delete everything"
        danger
        busy={busy}
        onConfirm={() => void deleteAll()}
        onCancel={() => !busy && setConfirm(false)}
      />
    </>
  );
}

/* ── Members ── */
export function MembersPage({ prefs }: PageProps) {
  const [avatar] = useStored<string>("minimi.avatar", "");
  const name = prefs.displayName || "You";
  return (
    <>
      <Head title="Members" sub="Who can use this workspace." />
      <Card>
        <Row icon={<Avatar text={initials(name)} size={28} tone="accent" src={avatar || undefined} />} title={name} desc={prefs.email || "No email set"}>
          <Badge tone="green">Owner</Badge>
        </Row>
      </Card>
      <H2 sub="Minimi runs on your device with a single user, so there is nobody to invite and no roles to manage.">Invite people</H2>
      <Card>
        <Row title="Invite by email" desc="Not available in local mode.">
          <Btn disabled title="Not available in local mode">Invite</Btn>
        </Row>
      </Card>
    </>
  );
}

/* ── Models ── */
export function ModelsPage() {
  const { ints, err, reload } = useIntegrations();
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; text?: string }>({ state: "idle" });

  const run = async () => {
    setTest({ state: "running" });
    try {
      const r = await api.testIntegration("llm");
      setTest(r.ok ? { state: "ok", text: `Connected · ${r.ms}ms` } : { state: "fail", text: r.error ?? "The model didn't respond." });
    } catch (e) {
      setTest({ state: "fail", text: errMsg(e) });
    }
  };

  if (err)
    return (
      <>
        <Head title="Models" sub="The models that answer your questions." />
        <div className="st-error" role="alert"><p>Couldn't load models: {err}</p><Btn onClick={reload}>Retry</Btn></div>
      </>
    );
  const llm = ints?.llm;
  return (
    <>
      <Head title="Models" sub="The models that answer your questions." />
      <Card>
        <Row title="Provider" desc="Set in Integrations or your server's environment">
          {llm ? <Badge tone={llm.connected ? "green" : "amber"}>{llm.provider} · {llm.connected ? "Connected" : "No key"}</Badge> : <span className="st-muted">Loading…</span>}
        </Row>
        <Row title="Fast model" desc="Quick questions and background memory work"><code className="st-code">{llm?.fastModel ?? "…"}</code></Row>
        <Row title="Main model" desc="The default for most answers"><code className="st-code">{llm?.mainModel ?? "…"}</code></Row>
        {llm?.smartModel && <Row title="Smart model" desc="Hard, multi-step questions"><code className="st-code">{llm.smartModel}</code></Row>}
      </Card>
      <H2>Connection</H2>
      <Card>
        <Row title="Test connection" desc={test.state === "idle" ? "Sends a tiny request to check your key and model." : test.state === "running" ? "Checking…" : test.text}>
          <Btn disabled={!llm?.connected || test.state === "running"} onClick={() => void run()}>{test.state === "running" ? "Testing…" : "Test"}</Btn>
        </Row>
        <Row title="Keys and providers" desc="Add or change API keys">
          <Btn onClick={openIntegrations}>Open Integrations</Btn>
        </Row>
      </Card>
    </>
  );
}

/* ── Security ── */
export function SecurityPage() {
  const toast = useToast();
  const { ints, err, reload } = useIntegrations();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const clearKey = async () => {
    setBusy(true);
    try {
      await api.setTavilyKey("");
      toast("Search key removed", "success");
      setConfirm(false);
      reload();
    } catch (e) {
      toast(`Couldn't remove the key: ${errMsg(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (err)
    return (
      <>
        <Head title="Security" sub="How access and keys are protected." />
        <div className="st-error" role="alert"><p>Couldn't load security info: {err}</p><Btn onClick={reload}>Retry</Btn></div>
      </>
    );
  const protectedApp = ints?.security?.accessProtected;
  return (
    <>
      <Head title="Security" sub="How access and keys are protected." />
      {ints && protectedApp === false && <Notice>Anyone who can reach this server can use it. Set ACCESS_TOKEN in your environment before exposing it beyond this device.</Notice>}
      <Card>
        <Row title="Access protection" desc={protectedApp ? "A username and password (HTTP Basic) are required to open the app." : "No password is set."}>
          {ints ? <Badge tone={protectedApp ? "green" : "amber"}>{protectedApp ? "On" : "Off"}</Badge> : <span className="st-muted">Loading…</span>}
        </Row>
        <Row title="Model API key" desc="Read from the server's environment. It is never sent to the browser.">
          {ints ? <Badge tone={ints.llm.connected ? "green" : "amber"}>{ints.llm.connected ? "Set" : "Not set"}</Badge> : null}
        </Row>
        <Row title="Search key" desc={ints?.search.hasTavilyKey ? `Tavily key ending ••••${ints.search.keyHint ?? ""}. The full key is never shown.` : "No key saved. Search uses the free provider."}>
          {ints?.search.hasTavilyKey && <Btn variant="danger" onClick={() => setConfirm(true)}>Remove…</Btn>}
        </Row>
        <Row title="Private network protection" desc="The server refuses to fetch pages on private addresses (localhost, 192.168.x.x and similar) so a prompt can't probe your network." />
      </Card>
      <ConfirmDialog open={confirm} title="Remove the saved search key?" message="You can add it again any time in Integrations." confirmLabel="Remove key" danger busy={busy} onConfirm={() => void clearKey()} onCancel={() => !busy && setConfirm(false)} />
    </>
  );
}

/* ── Billing ── */
export function BillingPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    setErr(null);
    api.stats().then(setStats).catch((e) => setErr(errMsg(e)));
  };
  useEffect(load, []);

  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const month = (stats?.activity ?? stats?.perDay ?? []).filter((d) => d.date.startsWith(ym)).reduce((n, d) => n + d.turns, 0);

  return (
    <>
      <Head title="Billing" sub="What this workspace has used." />
      <Notice>This is a local install: there are no credits, plans or invoices. Your only costs are the API keys you bring.</Notice>
      {err ? (
        <div className="st-error" role="alert"><p>Couldn't load usage: {err}</p><Btn onClick={load}>Retry</Btn></div>
      ) : (
        <>
          <H2>Usage</H2>
          <Card>
            <Row title="Questions this month">{stats ? <span className="st-num">{month.toLocaleString("en")}</span> : <span className="st-muted">…</span>}</Row>
            <Row title="Questions, all time">{stats ? <span className="st-num">{stats.totals.turns.toLocaleString("en")}</span> : <span className="st-muted">…</span>}</Row>
            <Row title="Web searches, all time">{stats ? <span className="st-num">{stats.totals.searches.toLocaleString("en")}</span> : <span className="st-muted">…</span>}</Row>
            <Row title="Average response time">{stats ? <span className="st-num">{stats.totals.turns ? fmtMs(stats.totals.avgMs) : "—"}</span> : <span className="st-muted">…</span>}</Row>
          </Card>
        </>
      )}
    </>
  );
}
