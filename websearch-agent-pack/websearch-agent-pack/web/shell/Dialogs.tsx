import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "./toast";
import { Dialog } from "./ui";
import { errMsg } from "./util";
import { MOD } from "./Sidebar";

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: [string, string][] = [
    ["Search chats & commands", `${MOD} K`],
    ["New chat", `${MOD} Shift O`],
    ["Toggle sidebar", `${MOD} B`],
    ["Send message", "Enter"],
    ["New line in message", "Shift Enter"],
    ["Close menu / dialog", "Esc"],
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" width={420}>
      <ul className="shortcuts">
        {rows.map(([label, keys]) => (
          <li key={label}>
            <span>{label}</span>
            <span className="keys">
              {keys.split(" ").map((k) => (
                <kbd key={k} className="kbd">
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function NameDialog({ open, onClose, name, onSave }: { open: boolean; onClose: () => void; name: string; onSave: (n: string) => void }) {
  const [v, setV] = useState(name);
  useEffect(() => {
    if (open) setV(name);
  }, [open, name]);
  const save = () => {
    const t = v.trim().slice(0, 40);
    if (!t) return;
    onSave(t);
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Display name"
      width={380}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!v.trim()}>
            Save
          </button>
        </>
      }
    >
      <label className="field-label" htmlFor="display-name">
        Shown in the sidebar on this device
      </label>
      <input
        id="display-name"
        className="input"
        value={v}
        maxLength={40}
        data-autofocus
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
        }}
      />
    </Dialog>
  );
}

export function ClockDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [now, setNow] = useState("");
  const [local, setLocal] = useState("");

  const load = async () => {
    try {
      const r = await api.getClock();
      setNow(r.now);
      const d = new Date(r.now);
      if (!Number.isNaN(d.getTime())) setLocal(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
    } catch (e) {
      toast(`Couldn't read clock: ${errMsg(e)}`, "error");
    }
  };
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = async () => {
    if (!local) return;
    try {
      const r = await api.setClock(new Date(local).toISOString());
      setNow(r.now);
      toast("Dev clock set", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };
  const reset = async () => {
    try {
      const r = await api.resetClock();
      setNow(r.now);
      toast("Dev clock reset to real time", "success");
      void load();
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Developer clock" width={420}>
      <p className="dialog-msg">Pretend “now” is a different moment to test time-aware memory recall. Only available in development.</p>
      <p className="mono small">Server time: {now || "…"}</p>
      <label className="field-label" htmlFor="clock-input">
        Set to
      </label>
      <input id="clock-input" type="datetime-local" className="input" value={local} onChange={(e) => setLocal(e.target.value)} />
      <div className="dialog-actions-row">
        <button type="button" className="btn btn-primary" onClick={set} disabled={!local}>
          Set
        </button>
        <button type="button" className="btn" onClick={reset}>
          Reset to real time
        </button>
      </div>
    </Dialog>
  );
}
