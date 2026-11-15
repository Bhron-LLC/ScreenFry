import React, { useEffect, useMemo, useState } from "react";
import { send } from "@browser/messages";
import { checkSettings, loadoutSettings } from "@core/actions";
import { createDefaultState } from "@core/defaults";
import {
  LIBRARY_LIMITS,
  LIBRARY_TAGS,
  REPORT_REASONS,
  checkPublishable,
  customWebsites,
  setupWebsites,
  type LibraryTag,
  type ReportReason,
} from "@core/library";
import { decodeShareCode, encodeShareCode, summarizeShared } from "@core/share";
import { siteDefinitions } from "@feeds/index";
import { LOADOUT_COUNT, type AppState } from "@shared/index";
import {
  LibraryError,
  deleteAllMySetups,
  deleteSetup,
  getSetup,
  mySetups,
  publishSetup,
  reportSetup,
  searchSetups,
  voteSetup,
  type LibraryCard,
  type LibrarySetup,
  type MySetup,
} from "../library/api";
import { deleteInstallKey, getInstallKey } from "../library/key";
import { confirmDialog } from "../ui/ConfirmDialog";
import { passwordGate } from "../ui/PasswordPrompt";
import { SettingsSummary, ShareSlides, listNames } from "../ui/ShareSlides";
import { shareSlides, type ShareSlide } from "../ui/share-changes";
import type { Notice } from "./index";

type Props = { state: AppState; onState: (s: AppState) => void; onNotice: (n: Notice) => void };

const site = (key: string) => siteDefinitions.find((s) => s.site === key);
const websiteName = (key: string) => site(key)?.name ?? key;
const loadoutName = (state: AppState, i: number) => state.loadoutNames?.[i]?.trim() || `Loadout ${i + 1}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const REASON_LABELS: Record<ReportReason, string> = {
  offensive: "Offensive or hateful",
  spam: "Spam or advertising",
  misleading: "Doesn’t do what it says",
  other: "Something else",
};
const STATUS_LABELS: Record<MySetup["status"], string> = {
  live: "In the library",
  hidden: "Hidden while it’s reviewed",
  removed: "Removed",
};

/** A website's colored mark, or its first letter for websites outside the registry. */
function WebsiteMark({ website }: { website: string }) {
  const s = site(website);
  return (
    <span
      className="site-avatar small-avatar"
      style={{ background: s?.color ?? "var(--muted)" }}
      title={s?.name ?? website}
      aria-label={s?.name ?? website}
    >
      {s?.symbol ?? website[0]?.toUpperCase()}
    </span>
  );
}

/**
 * The Share page's Library tab (docs/SETUP_LIBRARY.md): search setups other people published,
 * preview one with the same slides as a pasted code, and put it in a loadout through the same
 * core action. Off until turned on; nothing contacts the library before that.
 */
export function LibraryTab({ state, onState, onNotice }: Props) {
  if (!state.libraryEnabled) return <LibraryIntro state={state} onState={onState} onNotice={onNotice} />;
  return <LibraryBrowser state={state} onState={onState} onNotice={onNotice} />;
}

function LibraryIntro({ onState, onNotice }: Props) {
  const [busy, setBusy] = useState(false);
  async function turnOn() {
    setBusy(true);
    const r = await send<AppState>({ type: "SET_LIBRARY", enabled: true });
    setBusy(false);
    if (!r.ok) return onNotice({ kind: "error", text: r.error });
    onState(r.data);
  }
  return (
    <section className="card settings-block library">
      <h2>Setup library</h2>
      <p className="muted">
        Browse setups other people have shared, like “YouTube for studying” or “no Shorts, 30
        minutes of Reddit”. Preview what one changes, then put it in one of your loadouts.
      </p>
      <ul className="library-facts">
        <li>Searching sends only the words and filters you choose. Your settings, usage and history are never sent.</li>
        <li>Nothing about you is shared unless you publish a setup yourself, and you see everything that becomes public first.</li>
        <li>Everything else in ScreenFry keeps working without the library, or without a connection.</li>
      </ul>
      <button className="button" disabled={busy} onClick={() => void turnOn()}>
        Turn on the library
      </button>
    </section>
  );
}

function LibraryBrowser({ state, onState, onNotice }: Props) {
  const [q, setQ] = useState("");
  const [websites, setWebsites] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [sort, setSort] = useState<"top" | "new">("top");
  const [results, setResults] = useState<LibraryCard[]>();
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<string>();

  // Searches as you type (after a short pause) and whenever a filter changes.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError("");
      searchSetups({ q, websites, tags, sort })
        .then((r) => {
          if (!current) return;
          setResults(r.setups);
          setNext(r.next);
        })
        .catch((e) => current && setError(errorText(e)))
        .finally(() => current && setLoading(false));
    }, q ? 300 : 0);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, websites.join(), tags.join(), sort]);

  async function more() {
    if (!next) return;
    setLoading(true);
    try {
      const r = await searchSetups({ q, websites, tags, sort, cursor: next });
      setResults((old) => [...(old ?? []), ...r.setups]);
      setNext(r.next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  const toggle = (list: string[], set: (l: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  return (
    <>
      <section className="card settings-block library">
        <div className="row spread">
          <h2>Setup library</h2>
          <TurnOff onState={onState} onNotice={onNotice} />
        </div>
        <div className="library-search">
          <input
            type="search"
            aria-label="Search the library"
            placeholder="Search, like “studying” or “evenings”"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select aria-label="Order" value={sort} onChange={(e) => setSort(e.target.value as "top" | "new")}>
            <option value="top">Top</option>
            <option value="new">New</option>
          </select>
        </div>
        <div className="library-chips" role="group" aria-label="Websites">
          {siteDefinitions.map((s) => (
            <button
              key={s.site}
              type="button"
              className={`library-chip ${websites.includes(s.site) ? "on" : ""}`}
              aria-pressed={websites.includes(s.site)}
              onClick={() => toggle(websites, setWebsites, s.site)}
            >
              <WebsiteMark website={s.site} />
              {s.name}
            </button>
          ))}
        </div>
        <div className="library-chips" role="group" aria-label="Tags">
          {LIBRARY_TAGS.map((t) => (
            <button
              key={t}
              type="button"
              className={`library-chip tag ${tags.includes(t) ? "on" : ""}`}
              aria-pressed={tags.includes(t)}
              onClick={() => toggle(tags, setTags, t)}
            >
              #{t}
            </button>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {results && results.length === 0 && !loading && !error && (
          <div className="empty library-empty">
            <h3>No setups found</h3>
            <p>Try fewer filters, or publish one of your own from the Loadouts tab.</p>
          </div>
        )}
        <ul className="library-results" aria-busy={loading}>
          {results?.map((card) => (
            <li key={card.id} className={`library-card ${openId === card.id ? "open" : ""}`}>
              <button
                type="button"
                className="library-card-head"
                aria-expanded={openId === card.id}
                onClick={() => setOpenId(openId === card.id ? undefined : card.id)}
              >
                <span className="library-marks" aria-hidden="true">
                  {card.websites.slice(0, 4).map((w) => (
                    <WebsiteMark key={w} website={w} />
                  ))}
                </span>
                <span className="library-card-text">
                  <strong>{card.title}</strong>
                  {card.description && <span className="muted small">{card.description}</span>}
                  <span className="library-meta small">
                    {card.tags.map((t) => `#${t}`).join(" ")}
                    {card.tags.length ? " · " : ""}
                    {card.upvotes} upvote{card.upvotes === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
              {openId === card.id && (
                <SetupDetail id={card.id} state={state} onState={onState} onNotice={onNotice} onGone={() => setOpenId(undefined)} />
              )}
            </li>
          ))}
        </ul>
        {next && (
          <button className="button secondary" disabled={loading} onClick={() => void more()}>
            Show more
          </button>
        )}
      </section>
      <MySetups onNotice={onNotice} />
    </>
  );
}

function TurnOff({ onState, onNotice }: Pick<Props, "onState" | "onNotice">) {
  async function turnOff() {
    const yes = await confirmDialog({
      question: "Turn off the library?",
      detail: "ScreenFry stops contacting the library. Setups you published stay in it until you delete them.",
      yes: "Turn off",
      no: "Cancel",
    });
    if (!yes) return;
    const r = await send<AppState>({ type: "SET_LIBRARY", enabled: false });
    if (!r.ok) return onNotice({ kind: "error", text: r.error });
    if (await getInstallKey(false).catch(() => undefined)) {
      const forget = await confirmDialog({
        question: "Forget this browser’s library key too?",
        detail: "Without it you can’t delete setups you published from here. Delete them first if you want them gone.",
        yes: "Forget the key",
        no: "Keep it",
      });
      if (forget) deleteInstallKey();
    }
    onState(r.data);
  }
  return (
    <button type="button" className="button ghost" onClick={() => void turnOff()}>
      Turn off the library
    </button>
  );
}

/** One setup, opened: its slides compared with the chosen loadout, and what you can do with it. */
function SetupDetail({ id, state, onState, onNotice, onGone }: Props & { id: string; onGone: () => void }) {
  const active = state.activeLoadout ?? 0;
  const [setup, setSetup] = useState<LibrarySetup>();
  const [error, setError] = useState("");
  const [target, setTarget] = useState(active);
  const [slides, setSlides] = useState<ShareSlide[]>();
  const [busy, setBusy] = useState(false);
  const [voted, setVoted] = useState(false);
  const [upvotes, setUpvotes] = useState<number>();
  const [reporting, setReporting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    getSetup(id)
      .then((s) => current && setSetup(s))
      .catch((e) => current && setError(errorText(e)));
    return () => {
      current = false;
    };
  }, [id]);

  const settings = loadoutSettings(state, target, Date.now());
  const comparedWith = settings ?? createDefaultState();
  // Decoded and checked here, like a pasted code; the server's copy is never trusted as is.
  useEffect(() => {
    if (!setup) return;
    let current = true;
    decodeShareCode(setup.code)
      .then((data) => {
        if (!current) return;
        const { settings: incoming, error } = checkSettings(data, Date.now());
        if (!incoming) return setError(error!);
        setSlides(
          shareSlides(comparedWith, {
            ...incoming,
            earnGoals: incoming.earnGoals ?? comparedWith.earnGoals ?? [],
            warningsEnabled: incoming.warningsEnabled ?? comparedWith.warningsEnabled,
          }),
        );
      })
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [setup?.code, JSON.stringify({ ...comparedWith, savedAt: 0 })]);

  const name = loadoutName(state, target);
  async function apply() {
    if (!setup || !(await passwordGate(state))) return;
    if (settings) {
      const inUse = target === active;
      const yes = await confirmDialog({
        question: inUse ? "Replace your current setup?" : `Replace ${name}?`,
        detail: inUse
          ? `Your websites, windows, earn goals and feed blocking will be replaced with “${setup.title}”. Today’s usage and your password stay as they are.`
          : `The setup saved in ${name} will be replaced with “${setup.title}”.`,
        yes: "Replace",
        no: "Cancel",
      });
      if (!yes) return;
    }
    setBusy(true);
    const r = await send<AppState>({ type: "SET_LOADOUT_FROM_CODE", index: target, code: setup.code });
    setBusy(false);
    if (!r.ok) return onNotice({ kind: "error", text: r.error });
    onState(r.data);
    onNotice({ kind: "success", text: `${name} now has “${setup.title}”.` });
  }
  async function vote() {
    try {
      const r = await voteSetup(id, !voted);
      setVoted(r.voted);
      setUpvotes(r.upvotes);
    } catch (e) {
      onNotice({ kind: "error", text: errorText(e) });
    }
  }
  async function copy() {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      onNotice({ kind: "error", text: "Couldn’t copy the code." });
    }
  }

  if (error)
    return (
      <div className="library-detail">
        <p className="error" role="alert">
          {error}
        </p>
        {error.includes("anymore") && (
          <button className="button secondary" onClick={onGone}>
            Close
          </button>
        )}
      </div>
    );
  if (!setup || !slides) return <div className="library-detail muted small">Loading…</div>;
  return (
    <div className="library-detail">
      <div className="loadout-tabs compact" role="tablist" aria-label="Put it in">
        {Array.from({ length: LOADOUT_COUNT }, (_, i) => {
          const filled = i === active || Boolean(state.loadouts?.[i]);
          return (
            <button
              key={i}
              role="tab"
              aria-selected={target === i}
              className={`loadout-tab ${target === i ? "selected" : ""} ${filled ? "" : "empty"}`}
              onClick={() => setTarget(i)}
            >
              <strong>{loadoutName(state, i)}</strong>
              <span>{i === active ? "In use" : filled ? "Saved" : "Empty"}</span>
            </button>
          );
        })}
      </div>
      {slides.length === 0 ? (
        <p className="share-same">This setup matches {target === active ? "your current setup" : name}. Nothing would change.</p>
      ) : (
        <ShareSlides
          key={`${target}-${JSON.stringify(slides)}`}
          slides={slides}
          busy={busy}
          subject="This setup"
          applyLabel={`Use in ${name}`}
          onApply={() => void apply()}
        />
      )}
      <div className="row wrap library-actions">
        <button type="button" className={`button ${voted ? "" : "secondary"}`} aria-pressed={voted} onClick={() => void vote()}>
          ▲ {upvotes ?? setup.upvotes}
        </button>
        <button type="button" className="button secondary" onClick={() => void copy()}>
          {copied ? "Copied!" : "Copy code"}
        </button>
        <button type="button" className="button ghost" onClick={() => setReporting(!reporting)}>
          Report…
        </button>
      </div>
      {reporting && <ReportForm id={id} onDone={() => setReporting(false)} onNotice={onNotice} />}
    </div>
  );
}

function ReportForm({ id, onDone, onNotice }: { id: string; onDone: () => void; onNotice: (n: Notice) => void }) {
  const [reason, setReason] = useState<ReportReason>("offensive");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await reportSetup(id, reason, note);
      onNotice({ kind: "success", text: "Thanks. The setup is reviewed if others report it too." });
      onDone();
    } catch (err) {
      onNotice({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="library-report" onSubmit={(e) => void submit(e)}>
      <label>
        Why are you reporting it?
        <select value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
          {REPORT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REASON_LABELS[r]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Anything to add? (optional, only the library’s admins see it)
        <textarea maxLength={LIBRARY_LIMITS.reportNote} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="row">
        <button className="button" disabled={busy}>
          Send report
        </button>
        <button type="button" className="button secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Setups published from this browser (by its install key), with delete. */
function MySetups({ onNotice }: { onNotice: (n: Notice) => void }) {
  const [list, setList] = useState<MySetup[]>();
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    try {
      if (!(await getInstallKey(false))) return setList([]);
      setList((await mySetups()).setups);
    } catch (e) {
      onNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  async function remove(setup?: MySetup) {
    const yes = await confirmDialog({
      question: setup ? `Delete “${setup.title}” from the library?` : "Delete all your published setups?",
      detail: "People who already put it in a loadout keep their copy. It can’t be found in the library anymore.",
      yes: "Delete",
      no: "Cancel",
    });
    if (!yes) return;
    setBusy(true);
    try {
      if (setup) await deleteSetup(setup.id);
      else await deleteAllMySetups();
      onNotice({ kind: "success", text: setup ? "Deleted from the library." : "All your setups are deleted from the library." });
      await load();
    } catch (e) {
      onNotice({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card settings-block library-mine">
      <h2>Your published setups</h2>
      {!list ? (
        <button className="button secondary" disabled={busy} onClick={() => void load()}>
          Show them
        </button>
      ) : list.length === 0 ? (
        <p className="muted">You haven’t published anything from this browser. Publish a loadout from the Loadouts tab.</p>
      ) : (
        <>
          <ul className="library-mine-list">
            {list.map((s) => (
              <li key={s.id}>
                <span>
                  <strong>{s.title}</strong>
                  <span className={`pill ${s.status === "live" ? "good" : "warn"}`}>{STATUS_LABELS[s.status]}</span>
                  <span className="muted small"> {s.upvotes} upvote{s.upvotes === 1 ? "" : "s"}</span>
                </span>
                <button className="button ghost danger" disabled={busy} onClick={() => void remove(s)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
          <button className="button ghost danger" disabled={busy} onClick={() => void remove()}>
            Delete all my published setups
          </button>
        </>
      )}
    </section>
  );
}

/**
 * Publishing a loadout: a title, description and tags, and everything that becomes public,
 * shown before anything is sent.
 */
export function PublishDialog({ state, index, onClose, onNotice }: { state: AppState; index: number; onClose: () => void; onNotice: (n: Notice) => void }) {
  const settings = loadoutSettings(state, index, Date.now());
  const [title, setTitle] = useState(loadoutName(state, index).replace(/^Loadout \d$/, ""));
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<LibraryTag[]>([]);
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<string>();
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!settings) return;
    const { savedAt: _saved, ...rest } = settings;
    void encodeShareCode(rest).then(setCode);
  }, [JSON.stringify({ ...settings, savedAt: 0 })]);
  const websites = useMemo(() => (settings ? setupWebsites(settings) : []), [code]);
  const custom = customWebsites(websites);
  if (!settings) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const { setup, error } = await checkPublishable({ code, title, description, tags });
    if (!setup) return setError(error!);
    setBusy(true);
    try {
      setPublished((await publishSetup({ code: setup.code, title: setup.title, description: setup.description, tags: setup.tags })).id);
      onNotice({ kind: "success", text: `“${setup.title}” is in the library.` });
    } catch (err) {
      setError(err instanceof LibraryError && err.status === 409 ? "This setup is already in the library." : errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal card publish-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-title">
        <div className="modal-head">
          <h2 id="publish-title">Publish {loadoutName(state, index)}</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {published ? (
          <div className="publish-done">
            <p className="share-same">Published. Anyone using the library can find it now.</p>
            <p className="muted small">
              You can delete it any time under “Your published setups” in the Library tab.
            </p>
            <button className="button" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <label>
              Title
              <input
                required
                maxLength={LIBRARY_LIMITS.title}
                placeholder="Like “YouTube for studying”"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>
              Description (optional)
              <textarea maxLength={LIBRARY_LIMITS.description} value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <fieldset className="library-chips">
              <legend>Tags (up to {LIBRARY_LIMITS.tags})</legend>
              {LIBRARY_TAGS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`library-chip tag ${tags.includes(t) ? "on" : ""}`}
                  aria-pressed={tags.includes(t)}
                  disabled={!tags.includes(t) && tags.length >= LIBRARY_LIMITS.tags}
                  onClick={() => setTags(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t])}
                >
                  #{t}
                </button>
              ))}
            </fieldset>
            <div className="share-preview publish-public">
              <strong>Everyone will see:</strong>
              <ul>
                <li>Websites: {websites.length ? listNames(websites.map(websiteName)) : "none"}</li>
                {custom.length > 0 && (
                  <li>
                    Websites you added: <strong>{listNames(custom)}</strong>
                  </li>
                )}
                {settings.windows.length > 0 && <li>Window names: {listNames(settings.windows.map((w) => `“${w.label}”`))}</li>}
                {(settings.earnGoals ?? []).length > 0 && (
                  <li>Earn goal names: {listNames((settings.earnGoals ?? []).map((g) => `“${g.label}”`))}</li>
                )}
              </ul>
              <SettingsSummary summary={summarizeShared(settings)} />
              <p className="muted small">Never your usage, history or password.</p>
            </div>
            <label className="check">
              <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
              Anyone can find and use this setup.
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="focus-actions">
              <button type="button" className="button secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="button" disabled={!understood || !code || busy}>
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
