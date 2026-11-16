import React, { useState } from "react";
import type { SharedSummary } from "@core/share";
import type { ShareSlide } from "./share-changes";

/** "A and B", "A, B and C". */
export const listNames = (names: string[]) =>
  names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** What a loadout or code sets, as a short list. */
export function SettingsSummary({ summary }: { summary: SharedSummary }) {
  return (
    <ul>
      <li>
        {summary.blocked.length ? `Blocked: ${listNames(summary.blocked)}` : "No fully blocked websites"}
      </li>
      <li>{summary.limits.length ? `Daily limits: ${summary.limits.join(", ")}` : "No daily limits"}</li>
      <li>{summary.windows.length ? `Windows: ${listNames(summary.windows)}` : "No windows"}</li>
      {summary.earnGoals.length > 0 && <li>Earn goals: {summary.earnGoals.join("; ")}</li>}
      <li>
        {summary.feedBlockingOn
          ? `${summary.feedBlockers} feed and button blocker${summary.feedBlockers === 1 ? "" : "s"} on`
          : "Feed and button blocking off"}
      </li>
    </ul>
  );
}

/**
 * A slideshow of what a share code changes: one slide per website, each setting shown as
 * now → after. The apply button sits on the last slide; "Accept all" applies without paging.
 */
export function ShareSlides({
  slides,
  busy,
  applyLabel,
  onApply,
  subject = "This code",
}: {
  slides: ShareSlide[];
  busy: boolean;
  applyLabel: string;
  onApply: () => void;
  /** "This code" or "This setup": what makes the changes. */
  subject?: string;
}) {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const at = Math.min(index, slides.length - 1);
  const slide = slides[at];
  const last = at === slides.length - 1;
  const websites = slides.filter((s) => s.key !== "everywhere").length;
  const total = slides.reduce((n, s) => n + s.changes.length, 0);
  const go = (to: number) => {
    if (to < 0 || to >= slides.length || to === at) return;
    setDirection(to > at ? 1 : -1);
    setIndex(to);
  };
  return (
    <div
      className="share-slides"
      role="group"
      aria-roledescription="slideshow"
      aria-label={`What ${subject.toLowerCase()} changes`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") go(at + 1);
        if (e.key === "ArrowLeft") go(at - 1);
      }}
    >
      <div className="share-slides-head">
        <p>
          {subject} makes <strong>{total} change{total === 1 ? "" : "s"}</strong>
          {websites ? ` across ${websites} website${websites === 1 ? "" : "s"}` : ""}.
        </p>
        {!last && (
          <button type="button" className="button accent-outline" disabled={busy} onClick={onApply}>
            {busy ? "Saving…" : `Accept all ${total} changes`}
          </button>
        )}
      </div>
      <article
        key={`${slide.key}-${at}`}
        className={`share-slide ${direction > 0 ? "from-right" : "from-left"}`}
        aria-roledescription="slide"
        aria-label={`${at + 1} of ${slides.length}: ${slide.name}`}
      >
        <header>
          <span
            className="site-avatar small-avatar"
            style={{ background: slide.color ?? "var(--muted)" }}
            aria-hidden="true"
          >
            {slide.symbol ?? (slide.key === "everywhere" ? "✦" : slide.name[0].toUpperCase())}
          </span>
          <div>
            <h4>{slide.name}</h4>
            <span className="muted small">
              {slide.changes.length} change{slide.changes.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="share-slide-count">
            {at + 1} / {slides.length}
          </span>
        </header>
        <ul className="share-changes">
          {slide.changes.map((c) => (
            <li key={c.label}>
              <span className="share-change-label">{c.label}</span>
              <span className="share-change-values">
                <span className="share-from">{c.from}</span>
                <span className="share-arrow" aria-label="becomes">
                  →
                </span>
                <span className="share-to">{c.to}</span>
              </span>
            </li>
          ))}
        </ul>
      </article>
      <div className="share-nav">
        <button
          type="button"
          className="button secondary"
          disabled={at === 0}
          onClick={() => go(at - 1)}
        >
          ‹ Back
        </button>
        <div className="share-dots" role="tablist" aria-label="Slides">
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={i === at}
              aria-label={s.name}
              title={s.name}
              className={i === at ? "active" : ""}
              onClick={() => go(i)}
            />
          ))}
        </div>
        {last ? (
          <button type="button" className="button" disabled={busy} onClick={onApply}>
            {busy ? "Saving…" : applyLabel}
          </button>
        ) : (
          <button type="button" className="button" onClick={() => go(at + 1)}>
            Next ›
          </button>
        )}
      </div>
    </div>
  );
}
