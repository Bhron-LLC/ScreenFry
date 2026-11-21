import React, { useEffect, useRef, useState } from "react";
import { send } from "@browser/messages";
import { PRESETS, presetBackup, type Preset } from "@core/presets";
import { encodeShareCode } from "@core/share";
import type { AppState } from "@shared/index";
import { confirmDialog } from "../ui/ConfirmDialog";
import { passwordGate } from "../ui/PasswordPrompt";

type Notice = { kind: "success" | "error"; text: string };

/**
 * Four ready-made setups. They pop up the first time the settings page opens (a fresh
 * install, never after an update), and Websites → Presets opens them again. A preset applies
 * like a pasted share code to the setup in use; the current setup is saved in an empty
 * loadout first. Closing the first offer (✕ I'll choose my own settings) calls `onSkip`, so
 * the page can say where to find them again.
 */
export function PresetsDialog({
  state,
  first: firstOffer,
  onState,
  onNotice,
  onClose,
  onSkip,
}: {
  state: AppState;
  /** The one-time offer on a fresh install (not opened from Websites → Presets). */
  first: boolean;
  onState: (state: AppState) => void;
  onNotice: (notice: Notice) => void;
  onClose: () => void;
  onSkip: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && skip();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });

  function close() {
    if (!state.presetsOffered) void send<AppState>({ type: "PRESETS_OFFERED" }).then((r) => r.ok && onState(r.data));
    onClose();
  }
  /** ✕, Escape or a click outside: no preset this time. */
  function skip() {
    close();
    if (firstOffer) onSkip();
  }

  async function use(preset: Preset) {
    // The gate says no only when you chose "Set up password": get out of the way of that form.
    if (!(await passwordGate(state))) return close();
    const active = state.activeLoadout ?? 0;
    const { changed, empty } = await presetBackup(state, Date.now());
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
    <div className="loosen-backdrop" onMouseDown={(e) => e.target === e.currentTarget && skip()}>
      <section className="presets-dialog" role="dialog" aria-modal="true" aria-labelledby="presets-title">
        <button type="button" className="presets-skip" onClick={skip} title="Close without a preset">
          <span aria-hidden="true">✕</span> I’ll choose my own settings
        </button>
        <h2 id="presets-title">Start with a preset</h2>
        <p className="muted">
          Presets are ready-made setups. Instead of going through every website yourself, pick the
          one closest to what you want and ScreenFry is set up in one click. You can change
          anything afterwards.
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
      </section>
    </div>
  );
}
