import React, { useState } from "react";
import { send } from "@browser/messages";
import { isValidDomain, normalizeDomain } from "@core/domains";
import type { AppState } from "@shared/index";
import { passwordGate } from "../ui/PasswordPrompt";
import type { Notice } from "./index";
/**
 * Settings → Focus while browsing (beta, docs/FOCUS.md): websites you type. While one is the
 * tab in front, the ScreenFry Mac app turns on Do Not Disturb, and turns it off 10 seconds
 * after you leave. Only "Focus wanted: yes or no" goes to the app, never the website.
 */
export function FocusSites({
  state,
  onState,
  onNotice,
}: {
  state: AppState;
  onState: (s: AppState) => void;
  onNotice: (n: Notice) => void;
}) {
  const sites = state.focusSites ?? [];
  const [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(next: string[]) {
    if (!(await passwordGate(state))) return false;
    setBusy(true);
    const r = await send<AppState>({ type: "SET_FOCUS_SITES", sites: next });
    setBusy(false);
    if (!r.ok) {
      onNotice({ kind: "error", text: r.error });
      return false;
    }
    onState(r.data);
    return true;
  }
  async function add() {
    const domain = normalizeDomain(typed);
    if (!isValidDomain(domain))
      return onNotice({ kind: "error", text: "Type a website, like docs.google.com." });
    if (sites.includes(domain)) return setTyped("");
    if (await save([...sites, domain])) setTyped("");
  }
  return (
    <section className="card settings-block focus-block">
      <h2>
        Focus while browsing <span className="pill subtle">Beta</span>
      </h2>
      <p className="muted">
        While one of these websites is the tab in front, the ScreenFry Mac app turns on Do Not
        Disturb. It turns it off 10 seconds after you switch away; come back sooner and it
        stays on. The app only hears “Focus on” or “off”, never which website. Needs the Mac
        app and its two shortcuts (see Focus in the app).
      </p>
      <form
        className="focus-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          aria-label="Website for Focus"
          placeholder="docs.google.com"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button className="button secondary" disabled={busy || !typed.trim()}>
          Add
        </button>
      </form>
      {sites.length > 0 ? (
        <ul className="focus-sites" aria-label="Focus websites">
          {sites.map((site) => (
            <li key={site}>
              <span>{site}</span>
              <button
                type="button"
                className="focus-remove"
                aria-label={`Remove ${site}`}
                disabled={busy}
                onClick={() => void save(sites.filter((s) => s !== site))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No websites yet.</p>
      )}
    </section>
  );
}
