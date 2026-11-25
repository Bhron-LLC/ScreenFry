/** Reads URL, selector attributes and media playback state only. No page text or form data. */
import { migrateState } from "@core/defaults";
import {
  activeShortForm,
  buildBlockingCss,
  enabledElements,
  researchMode,
  shortFormBlock,
  siteFor,
} from "@feeds/index";
import type { TabMessage } from "@browser/messages";
import { STATE_KEY } from "@browser/storage";
import { hostMatchesDomain } from "@core/domains";
import { createBlockedScreen } from "./blocked-screen";
import { createBatchedTask } from "@browser/scheduling";
import {
  earnCompletions,
  earnGoalCap,
  earnGoalUsed,
  earnGoalsFor,
  earnRemaining,
  effectiveFeedSettings,
  evaluatePolicy,
  matchingRules,
  usageFor,
} from "@policy/index";
import type { AppState, FeedSettings, PolicyDecision } from "@shared/index";
const isTop = window === window.top;
let state: AppState | undefined;
let pageBlocked = false;
/** Research mode: the first short-form video this page reached, and the pages before it. */
let linked: { url: string; id: string } | undefined;
const visitedBefore = new Set<string>();
const blockedScreen = createBlockedScreen();
const STYLE = "screenfry-feed-blocker";
/** The free-time window that was pausing feed blocking at the last evaluation. */
let freeTimeLabel: string | undefined;
let lastReportedPlaying: boolean | undefined,
  lastReportAt = 0;
/** Saved feed settings, minus this website's while its free time is running. */
let feedsCache: { state: AppState; href: string; second: number; feeds: FeedSettings } | undefined;
function feeds(): FeedSettings | undefined {
  if (!state) return undefined;
  // Called for every video on media events; reuse within the same second (see currentDecision).
  const second = Math.floor(Date.now() / 1000);
  if (!feedsCache || feedsCache.state !== state || feedsCache.href !== location.href || feedsCache.second !== second)
    feedsCache = { state, href: location.href, second, feeds: effectiveFeedSettings(state, location.href, Date.now()) };
  return feedsCache.feeds;
}
function research() {
  const settings = feeds();
  return settings && researchMode(settings, location.hostname);
}
const pageKey = (href: string) => {
  const url = new URL(href);
  return url.origin + url.pathname.replace(/\/+$/, "");
};
/** Notes the linked video (or a page before it) for research mode. */
function trackResearch() {
  const mode = research();
  if (!mode) {
    linked = undefined;
    visitedBefore.clear();
    return;
  }
  if (linked) return;
  const id = mode.videoId(new URL(location.href));
  if (id) linked = { url: location.href, id };
  else visitedBefore.add(pageKey(location.href));
}
/** Research mode: anything past the linked video in this page, such as the next video or
 * its creator’s profile. Pages visited before it stay open. */
function beyondLinkedVideo() {
  const mode = research();
  if (!mode || !linked) return false;
  const id = mode.videoId(new URL(location.href));
  if (id) return id !== linked.id;
  return !visitedBefore.has(pageKey(location.href));
}
function applyCss(css: string) {
  let sheet = document.getElementById(STYLE) as HTMLStyleElement | null;
  if (!css) {
    sheet?.remove();
    applyShadowCss(css);
    return;
  }
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = STYLE;
  }
  if (sheet.textContent !== css) sheet.textContent = css;
  const parent = document.head ?? document.documentElement;
  if (sheet.parentNode !== parent) parent.append(sheet);
  applyShadowCss(css);
}
/** The same CSS inside players that draw overlays in their own shadow root (Reddit's end
 * screen), checked on every evaluation since players attach their shadow root late. */
function applyShadowCss(css: string) {
  const hosts = siteFor(location.hostname)?.shadowHosts;
  if (!hosts?.length) return;
  for (const host of document.querySelectorAll(hosts.join(","))) {
    const root = host.shadowRoot;
    if (!root) continue;
    let sheet = root.getElementById(STYLE) as HTMLStyleElement | null;
    if (!css) {
      sheet?.remove();
      continue;
    }
    if (!sheet) {
      sheet = document.createElement("style");
      sheet.id = STYLE;
      root.append(sheet);
    }
    if (sheet.textContent !== css) sheet.textContent = css;
  }
}
function documentShortForm(): string | undefined {
  const settings = feeds();
  if (!settings) return;
  const short = activeShortForm(settings, location.hostname);
  if (!short) return;
  // SPA navigation can update the canonical link before the address bar.
  const canonical = document.querySelector<HTMLLinkElement>(
    'link[rel="canonical"]',
  )?.href;
  if (canonical && shortFormBlock(settings, canonical))
    return short.label;
  if (document.querySelector(short.playerSelectors.join(",")))
    return short.label;
}
/**
 * What may not play here, worked out once per address, settings and second rather than for
 * every video on every media event: busy pages (TikTok and X Explore) hold dozens of videos.
 */
let mediaRulesCache:
  | { state: AppState; href: string; second: number; blocked: boolean; all: boolean; selector: string }
  | undefined;
function mediaRules() {
  const second = Math.floor(Date.now() / 1000);
  const c = mediaRulesCache;
  if (c && c.state === state && c.href === location.href && c.second === second && c.blocked === pageBlocked)
    return c;
  const settings = feeds()!;
  const all =
    pageBlocked ||
    beyondLinkedVideo() ||
    currentDecision().status === "blocked" ||
    Boolean(shortFormBlock(settings, location.href) || documentShortForm());
  const selectors = enabledElements(settings, location.href)
    .filter((element) => element.pauseMedia)
    .flatMap((element) => element.selectors)
    .filter((selector) => {
      try {
        document.createDocumentFragment().querySelector(selector);
        return true;
      } catch {
        return false;
      }
    });
  return (mediaRulesCache = {
    state: state!,
    href: location.href,
    second,
    blocked: pageBlocked,
    all,
    selector: selectors.join(","),
  });
}
function blockedMedia(media: HTMLMediaElement): boolean {
  if (!state) return false;
  const rules = mediaRules();
  return rules.all || Boolean(rules.selector && media.closest(rules.selector));
}
/**
 * Some sites start a video again the moment it is paused. Answering every restart in turn
 * kept Safari busy without end, so a video that keeps restarting is also muted and after
 * that paused at most once a second.
 */
const pauses = new WeakMap<HTMLMediaElement, { count: number; since: number; last: number }>();
function pauseBlocked(media: HTMLMediaElement) {
  const now = Date.now();
  let record = pauses.get(media);
  if (!record || now - record.since > 5_000) record = { count: 0, since: now, last: 0 };
  pauses.set(media, record);
  record.count += 1;
  if (record.count > 3) {
    media.muted = true;
    media.autoplay = false;
    if (now - record.last < 1_000) {
      queueMediaCheck();
      return;
    }
  }
  record.last = now;
  media.pause();
}
function pauseRestrictedMedia() {
  for (const media of document.querySelectorAll<HTMLMediaElement>(
    "video,audio",
  ))
    if (!media.paused && blockedMedia(media)) pauseBlocked(media);
}
function reportMedia() {
  const playing = [
    ...document.querySelectorAll<HTMLMediaElement>("video,audio"),
  ].some((m) => !m.paused && !m.ended && m.readyState >= 2 && !blockedMedia(m));
  if (playing === lastReportedPlaying && Date.now() - lastReportAt < 10_000)
    return;
  lastReportedPlaying = playing;
  lastReportAt = Date.now();
  try {
    void chrome.runtime
      .sendMessage({ type: "MEDIA_STATE", playing })
      .catch(() => undefined);
  } catch {
    /* extension reloaded */
  }
}
/**
 * On an earn goal website, tell the background whether this page is visible and focused, so
 * goal time stops the moment you switch to another tab, window or app (it doesn't wait for
 * the browser's tab reports). Sent on changes, and again every 15 seconds to stay current.
 */
let lastFocusReport: boolean | undefined;
let lastFocusReportAt = 0;
function reportFocus() {
  if (!isTop || !state || !earnGoalsFor(state, location.href).length) return;
  const focused = document.visibilityState === "visible" && document.hasFocus();
  if (focused === lastFocusReport && Date.now() - lastFocusReportAt < 15_000) return;
  lastFocusReport = focused;
  lastFocusReportAt = Date.now();
  try {
    void chrome.runtime.sendMessage({ type: "PAGE_FOCUS", focused }).catch(() => undefined);
  } catch {
    /* extension reloaded */
  }
}
function markXTab() {
  if (siteFor(location.hostname)?.site !== "x") return;
  const tabs = [
    ...document.querySelectorAll(
      '[data-testid="primaryColumn"] [role="tablist"] [role="tab"]',
    ),
  ];
  const index = tabs.findIndex(
    (tab) => tab.getAttribute("aria-selected") === "true",
  );
  const value = index < 0 ? "" : String(index);
  if (document.documentElement.dataset.screenfryXTab !== value)
    document.documentElement.dataset.screenfryXTab = value;
}
/**
 * The policy decision for this page, reused within the same second for the same settings and
 * address: it only changes with settings, navigation or the clock.
 */
let decisionCache: { state: AppState; href: string; second: number; decision: PolicyDecision } | undefined;
function currentDecision(): PolicyDecision {
  const now = Date.now();
  const second = Math.floor(now / 1000);
  if (
    !decisionCache ||
    decisionCache.state !== state ||
    decisionCache.href !== location.href ||
    decisionCache.second !== second
  )
    decisionCache = { state: state!, href: location.href, second, decision: evaluatePolicy(state!, location.href, now) };
  return decisionCache.decision;
}
function evaluate() {
  if (!state || !/^https?:/.test(location.href) || !document.documentElement)
    return;
  trackResearch();
  syncScrollGuards();
  const decision = currentDecision();
  const short = documentShortForm();
  const single = beyondLinkedVideo();
  if (decision.status === "blocked" || short || single) {
    pageBlocked = true;
    freeTimeLabel = undefined;
    // Never wait for a background navigation or stop the document while Safari is loading.
    for (const media of document.querySelectorAll<HTMLMediaElement>(
      "video,audio",
    ))
      if (!media.paused) pauseBlocked(media);
    const label = short ?? decision.ruleLabel ?? siteFor(location.hostname)?.name ?? "This website";
    if (!isTop) {
      applyCss(
        "html{visibility:hidden!important}video,audio{display:none!important}",
      );
      reportMedia();
      return;
    }
    applyCss(
      "body{visibility:hidden!important}video,audio{display:none!important}",
    );
    if (single && !short && decision.status !== "blocked" && linked)
      // Research mode: past the linked video, start over at the website's home page.
      blockedScreen.redirect(linked.url, `${location.origin}/`, siteFor(location.hostname)?.name ?? location.hostname);
    else
      blockedScreen.show(
        short
          ? { ...decision, status: "blocked", reasons: ["short-form"] }
          : decision,
        label,
        single ? linked?.url : undefined,
      );
    overlay.timers(undefined);
    reportMedia();
    return;
  }
  pageBlocked = false;
  blockedScreen.hide();
  markXTab();
  applyCss(buildBlockingCss(feeds()!, location.href));
  pauseRestrictedMedia();
  reportMedia();
  if (isTop) {
    overlay.timers(decision);
    if (freeTimeLabel && !decision.freeTime)
      overlay.toast(
        decision.freeTimeOff?.state === "used-up"
          ? `Today’s Fry Time is used up. Feeds are hidden again.`
          : `${freeTimeLabel} is over. Feeds are hidden again.`,
      );
    freeTimeLabel = decision.freeTime?.label;
  }
}
// Busy pages (TikTok, X) change their layout many times a second; checking at most four
// times a second is plenty, and the one-second timer covers the clock.
const queueEvaluation = createBatchedTask(evaluate, 250);
/** Media events come in bursts; pausing and reporting playback once per burst is enough. */
const queueMediaCheck = createBatchedTask(() => {
  if (!state) return;
  pauseRestrictedMedia();
  reportMedia();
}, 250);
/**
 * ScreenFry's timers on a website, bottom right: the Earn counter on a goal website, Fry Time
 * left, and the daily limit ("Display timer on site"). They stack in one design, and "–"
 * shrinks them all to a dot, remembered per website (so the website reopens the same way).
 */
const TIMERS_MINIMIZED_KEY = "screenfry.timersMinimized";
/** 1.0.3 remembered one choice for every website; it's the default for websites not chosen since. */
const OLD_EARN_MINIMIZED_KEY = "screenfry.earnCounterMinimized";
/** A clock for the timers: 4:05, or 1:04:05 from an hour. */
function timerClock(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
const overlay = (() => {
  let host: HTMLElement | undefined, toast: HTMLElement, stack: HTMLElement, dot: HTMLButtonElement, hide: HTMLButtonElement;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let minimizedBySite: Record<string, boolean> = {};
  let minimizedByDefault = false;
  let loaded = false;
  let lines: string[] = [];
  const siteKey = () => siteFor(location.hostname)?.site ?? location.hostname.replace(/^www\./, "");
  const minimized = () => minimizedBySite[siteKey()] ?? minimizedByDefault;
  void chrome.storage.local.get([TIMERS_MINIMIZED_KEY, OLD_EARN_MINIMIZED_KEY]).then((stored) => {
    minimizedBySite = (stored[TIMERS_MINIMIZED_KEY] as Record<string, boolean>) ?? {};
    minimizedByDefault = stored[OLD_EARN_MINIMIZED_KEY] === true;
    loaded = true;
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[TIMERS_MINIMIZED_KEY]) return;
    minimizedBySite = (changes[TIMERS_MINIMIZED_KEY].newValue as Record<string, boolean>) ?? {};
    render();
  });
  function minimize(value: boolean) {
    minimizedBySite = { ...minimizedBySite, [siteKey()]: value };
    render();
    void chrome.storage.local.get(TIMERS_MINIMIZED_KEY).then((stored) =>
      chrome.storage.local.set({
        [TIMERS_MINIMIZED_KEY]: { ...((stored[TIMERS_MINIMIZED_KEY] as Record<string, boolean>) ?? {}), [siteKey()]: value },
      }),
    );
  }
  function ensure() {
    if (!document.body) return;
    if (!host) {
      host = document.createElement("screenfry-overlay");
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>:host{all:initial}.wrap{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:grid;gap:8px;justify-items:end;font:500 13px/1.3 system-ui}.chip{display:none;padding:10px 14px;border-radius:99px;background:#f4621f;color:white;box-shadow:0 5px 20px #0003;font-variant-numeric:tabular-nums}.toast{background:#263a32}.show{display:block}.stack{display:none;gap:6px;justify-items:end}.stack.show{display:grid}.stack .chip{display:flex;align-items:center;gap:8px}.stack .chip:last-child{padding-right:8px}.hide{all:unset;cursor:pointer;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:700 14px/1 system-ui;color:#fff;background:#0002}.hide:hover,.hide:focus-visible{background:#0004}.dot{all:unset;display:none;cursor:pointer;width:14px;height:14px;border-radius:50%;background:#f4621f;box-shadow:0 0 0 3px #f4621f40,0 4px 12px #0003}.dot.show{display:block}.dot:hover,.dot:focus-visible{box-shadow:0 0 0 5px #f4621f55,0 4px 12px #0003}</style><div class="wrap"><div class="chip toast"></div><div class="stack"></div><button class="dot" type="button" aria-label="Show ScreenFry's timers"></button></div>`;
      toast = root.querySelector(".toast")!;
      stack = root.querySelector(".stack")!;
      dot = root.querySelector(".dot")!;
      hide = document.createElement("button");
      hide.className = "hide";
      hide.type = "button";
      hide.title = "Minimize to a dot";
      hide.setAttribute("aria-label", "Minimize ScreenFry's timers");
      hide.textContent = "–";
      // Clicks stay inside the timers, so the website underneath never sees them.
      const toggle = (value: boolean) => (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        minimize(value);
      };
      hide.addEventListener("click", toggle(true));
      dot.addEventListener("click", toggle(false));
    }
    if (!host.isConnected) document.documentElement.append(host);
  }
  /** Shows the timers' lines, or the dot, or nothing. Chips are reused so "–" stays put. */
  function render() {
    if (!lines.length || !loaded) {
      stack?.classList.remove("show");
      dot?.classList.remove("show");
      return;
    }
    ensure();
    if (!stack) return;
    while (stack.children.length > lines.length) stack.lastElementChild!.remove();
    while (stack.children.length < lines.length) {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.append(document.createElement("span"));
      stack.append(chip);
    }
    lines.forEach((line, i) => {
      const text = stack.children[i].firstElementChild!;
      if (text.textContent !== line) text.textContent = line;
    });
    if (hide.parentElement !== stack.lastElementChild) stack.lastElementChild!.append(hide);
    dot.title = `${lines.join("\n")}\n(click to show)`;
    stack.classList.toggle("show", !minimized());
    dot.classList.toggle("show", minimized());
  }
  return {
    /** The timers for this page now (nothing on a blocked page). */
    timers(decision: PolicyDecision | undefined) {
      const next: string[] = [];
      if (state && decision) {
        const now = Date.now();
        const focused = document.visibilityState === "visible" && document.hasFocus();
        const playing = [...document.querySelectorAll<HTMLMediaElement>("video,audio")].some(
          (m) => !m.paused && !m.ended && m.readyState >= 2,
        );
        // Time since the background last saved usage, while this page counts.
        const since = (counting: boolean) =>
          counting && state!.usageAsOf ? Math.max(0, Math.min(90_000, now - state!.usageAsOf)) : 0;
        // Earn: only active time counts toward a goal (the tab in front, you at the computer).
        const goal = state.showEarnCounter === false
          ? undefined
          : earnGoalsFor(state, location.href).find((g) => earnRemaining(state!, g, now) > 0);
        if (goal) {
          const step = goal.minutes * 60_000;
          const toward = Math.min(step, (earnGoalUsed(state, goal, now) % step) + since(focused));
          // A goal that pays out several times a day says how many it has earned: "1/3 earned".
          const cap = earnGoalCap(goal);
          const count = earnCompletions(state, goal, now);
          const tally = cap <= 1 ? "" : ` · ${count}${cap === Infinity ? "" : `/${cap}`} earned`;
          next.push(`${focused ? "Earning" : "Paused"} · ${goal.label} · ${timerClock(toward)} of ${timerClock(step)}${tally}${goal.strict ? " · strict" : ""}`);
        }
        // Fry Time, from a window or earned: always shown while it lasts.
        const free = decision.freeTime?.remainingMilliseconds;
        if (free !== undefined) next.push(`Fry Time · ${timerClock(free - since(focused || playing))} left`);
        // The daily limit, when "Display timer on site" is on: time left, or time used today
        // on a website without a limit. Fry Time never lifts a limit, so both can show.
        const timed = matchingRules(state, location.href).find((r) => r.showTimer);
        if (timed) {
          const left = decision.remainingMilliseconds;
          next.push(
            left !== undefined
              ? `${timed.label} · ${timerClock(left - since(focused || playing))} left today`
              : `${timed.label} · ${timerClock(usageFor(state, timed.id, new Date(now)) + since(focused || playing))} today`,
          );
        }
      }
      lines = next;
      render();
    },
    toast(text: string) {
      ensure();
      if (!toast) return;
      toast.textContent = text;
      toast.classList.add("show");
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 8_000);
    },
  };
})();
/** True when ScreenFry has anything to do on this page: a launch site, a rule/window domain or an earn goal website. */
function relevantHost(s: AppState | undefined): boolean {
  const host = location.hostname;
  if (siteFor(host)) return true;
  if (!s) return false;
  const covers = (domains: string[]) =>
    domains.some((d) => hostMatchesDomain(host, d));
  return (
    s.rules.some((r) => r.enabled && covers(r.domains)) ||
    s.windows.some((w) => w.enabled && covers(w.domains)) ||
    // Earn goal websites show their live timer.
    (s.earnGoals ?? []).some((g) => g.enabled && covers(g.goalDomains))
  );
}
/**
 * The script is injected into every page and frame, so unrelated pages must stay idle: after
 * one state read they register no timer, observer or listener. Blocking on those pages is
 * still enforced by the background's network rules and tab redirects.
 */
let started = false;
function start() {
  if (started) return;
  started = true;
  // Usage is saved often while something plays. A tab in the background only needs the
  // newest state when it is shown again (its media is still checked on media events).
  let pendingState: unknown;
  const applyPending = () => {
    if (pendingState === undefined) return;
    state = migrateState(pendingState);
    pendingState = undefined;
    queueEvaluation();
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STATE_KEY]) {
      pendingState = changes[STATE_KEY].newValue;
      if (document.visibilityState === "visible") applyPending();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") applyPending();
  });
  startPageWatchers();
}
async function load() {
  try {
    state = migrateState(
      (await chrome.storage.local.get(STATE_KEY))[STATE_KEY],
    );
    if (!relevantHost(state)) return false;
    start();
    evaluate();
    return true;
  } catch {
    /* unavailable context */
    return false;
  }
}
// Launch sites start watching at document_start, before state arrives, so Shorts/Reels
// entry points can't slip through; everything else waits for the state check.
if (siteFor(location.hostname)) start();
void load();
let guardedResearch: ReturnType<typeof research> | undefined;
function guardScroll(event: Event) {
  // Block moving on to the next video, not scrolling comments or typing in a field.
  const mode = guardedResearch;
  if (!mode || !linked || !(event.target instanceof Element)) return;
  const keep = ['input', 'textarea', '[contenteditable="true"]', ...(mode.keepScrolling ?? [])].join(",");
  if (event.target.closest(keep)) return;
  const keyboard = event instanceof KeyboardEvent;
  if (
    keyboard &&
    !["ArrowDown", "ArrowUp", "PageDown", "PageUp", " "].includes(event.key)
  )
    return;
  if (keyboard || event.target.closest(mode.scrollSelectors.join(","))) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
let scrollGuardsInstalled = false;
function syncScrollGuards() {
  const mode = research();
  guardedResearch = mode && linked && !beyondLinkedVideo() ? mode : undefined;
  const enabled = Boolean(guardedResearch);
  if (enabled === scrollGuardsInstalled) return;
  scrollGuardsInstalled = enabled;
  for (const event of ["wheel", "touchmove", "keydown"]) {
    // These need preventDefault, but only while a linked video is open in research mode.
    if (enabled)
      window.addEventListener(event, guardScroll, {
        capture: true,
        passive: false,
      });
    else window.removeEventListener(event, guardScroll, true);
  }
}
function startPageWatchers() {
  // CSS already applies to new elements. Only supported social sites need DOM checks
  // for player/modal and selected-tab changes; unrelated pages keep timer/media tracking.
  // A website may repeatedly remove our style, so never respond in a microtask loop.
  if (siteFor(location.hostname)) {
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !(record.target instanceof Element && record.target.id === STYLE),
        )
      )
        queueEvaluation();
    });
    const observe = () => {
      if (document.documentElement)
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [
            "href",
            "src",
            "aria-selected",
            "is-active",
            "hidden",
          ],
        });
    };
    if (document.documentElement) observe();
    else document.addEventListener("DOMContentLoaded", observe, { once: true });
  }
  for (const event of [
    "play",
    "playing",
    "pause",
    "ended",
    "emptied",
    "loadeddata",
  ])
    document.addEventListener(
      event,
      (e) => {
        if (
          e.target instanceof HTMLMediaElement &&
          !e.target.paused &&
          blockedMedia(e.target)
        )
          pauseBlocked(e.target);
        queueMediaCheck();
      },
      true,
    );
  for (const event of [
    "popstate",
    "hashchange",
    "yt-navigate-start",
    "yt-navigate-finish",
  ])
    window.addEventListener(event, queueEvaluation, true);
  // Top frames refresh every second for the on-page timer; embedded frames only need
  // occasional checks because media events and the background cover the rest.
  setInterval(() => {
    evaluate();
    reportFocus();
  }, isTop ? 1000 : 5000);
  if (isTop) {
    // Focus can land in an embedded frame (still this page), so each event re-reads it.
    document.addEventListener("visibilitychange", () => reportFocus());
    window.addEventListener("focus", () => reportFocus());
    window.addEventListener("blur", () => reportFocus());
  }
  document.addEventListener("DOMContentLoaded", evaluate, { once: true });
  window.addEventListener("pagehide", () => {
    if (lastFocusReport) {
      try {
        void chrome.runtime.sendMessage({ type: "PAGE_FOCUS", focused: false }).catch(() => undefined);
      } catch {
        /* unloaded */
      }
      lastFocusReport = false;
    }
    if (!lastReportedPlaying) return;
    try {
      void chrome.runtime
        .sendMessage({ type: "MEDIA_STATE", playing: false })
        .catch(() => undefined);
    } catch {
      /* unloaded */
    }
  });
}
if (isTop)
  chrome.runtime.onMessage.addListener(
    (message: TabMessage, _sender, respond) => {
      if (message?.type === "SCREENFRY_APPLY_SETTINGS") {
        void load().then((applied) => respond({ applied, url: location.href }));
        return true;
      }
      if (message?.type === "SCREENFRY_TOAST") overlay.toast(message.text);
      if (message?.type === "SCREENFRY_WARNING")
        overlay.toast(
          `${message.minutesRemaining} minute${message.minutesRemaining === 1 ? "" : "s"} left on ${message.label} today`,
        );
    },
  );
