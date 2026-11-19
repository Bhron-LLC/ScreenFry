import React, { useEffect, useRef, useState } from "react";
import { send } from "@browser/messages";
import { loadoutSettings } from "@core/actions";
import { createDefaultState } from "@core/defaults";
import { PRESETS, type Preset } from "@core/presets";
import { encodeShareCode } from "@core/share";
import { LOADOUT_COUNT, type AppState } from "@shared/index";
import { confirmDialog } from "../ui/ConfirmDialog";
import { passwordGate } from "../ui/PasswordPrompt";

type Notice = { kind: "success" | "error"; text: string };

/**
 * Four ready-made setups. They pop up the first time the settings page opens (a fresh
 * install), and Websites → Presets opens them again. A preset applies like a pasted share
 * code to the setup in use; the current setup is saved in an empty loadout first.
 */
export function PresetsDialog({
  state,
  onState,
  onNotice,
  onClose,
}: {
  state: AppState;
  onState: (state: AppState) => void;
  onNotice: (notice: Notice) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  function close() {
    if (!state.presetsOffered) void send<AppState>({ type: "PRESETS_OFFERED" }).then((r) => r.ok && onState(r.data));
    onClose();
  }

  async function use(preset: Preset) {
    if (!(await passwordGate(state))) return;
    const active = state.activeLoadout ?? 0;
    const setupOf = (s: AppState) => {
      const { rules, windows, earnGoals, feedSettings } = loadoutSettings(s, s.activeLoadout ?? 0, Date.now())!;
      return { rules, windows, earnGoals, feedSettings, warningsEnabled: state.warningsEnabled };
    };
    const current = await encodeShareCode(setupOf(state));
    const fresh = await encodeShareCode(setupOf(createDefaultState()));
    const changed = current !== fresh;
    const empty = Array.from({ length: LOADOUT_COUNT }, (_, i) => i).find((i) => i !== active && !state.loadouts?.[i]);
    const yes = await confirmDialog({
      question: `Use ${preset.name}?`,
      detail: !changed
        ? "ScreenFry's settings change to this preset. Change anything afterwards."
        : empty !== undefined
          ? `Your current setup is saved in Loadout ${empty + 1} first, so you can switch back from Share. Today's usage and your password stay as they are.`
          : "This replaces your current websites, windows, earn goals and feed blocking (every loadout is full, so it isn't saved). Today's usage and your password stay as they are.",
      yes: `Use ${preset.name}`,
      no: "Cancel",
    });
    if (!yes) return;
    setBusy(true);
    if (changed && empty !== undefined) {
      const saved = await send<AppState>({ type: "COPY_TO_LOADOUT", index: empty });
      if (!saved.ok) {
        setBusy(false);
        return onNotice({ kind: "error", text: saved.error });
      }
    }
    const code = await encodeShareCode(preset.settings());
    const r = await send<AppState>({ type: "SET_LOADOUT_FROM_CODE", index: active, code });
    setBusy(false);
    if (!r.ok) return onNotice({ kind: "error", text: r.error });
    onState(r.data);
    onNotice({
      kind: "success",
      text: `Now using ${preset.name}.${changed && empty !== undefined ? ` Your previous setup is in Loadout ${empty + 1}.` : ""} Change any website whenever you like.`,
    });
    close();
  }

  return (
    <div className="loosen-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section className="presets-dialog" role="dialog" aria-modal="true" aria-labelledby="presets-title">
        <h2 id="presets-title">Start with a preset</h2>
        <p className="muted">
          Pick one to set ScreenFry up in one go. You can change anything afterwards, and open these
          again from Websites → Presets.
        </p>
        <div className="presets-grid">
          {PRESETS.map((preset, i) => (
            <article key={preset.id} className="preset-card">
              <h3>{preset.name}</h3>
              <p className="preset-summary">{preset.summary}</p>
              <ul>
                {preset.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              <button
                ref={i === 0 ? first : undefined}
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void use(preset)}
              >
                Use {preset.name}
              </button>
            </article>
          ))}
        </div>
        <div className="presets-footer">
          <button type="button" className="button secondary" onClick={close}>
            {state.presetsOffered ? "Close" : "Start from scratch"}
          </button>
        </div>
      </section>
    </div>
  );
}
