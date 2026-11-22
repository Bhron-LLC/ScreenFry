/** Isolated Chrome integration test. All website fixtures are served through the test protocol locally; no user profile is touched. */
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "../..");
const profile = mkdtempSync(join(tmpdir(), "screenfry-e2e-"));
const fixture = readFileSync(join(root, "tests/fixtures/playing.webm"));
const fixtureHtml = `<!doctype html><html><head><title>Local website fixture</title></head><body>
    <h1>Useful content</h1><a href="/shorts/fixture" id="notification">Shorts notification</a>
    <button id="spa">Open Shorts without reloading</button><button id="modal">Open short-form modal</button>
    <div id="regular-player"><video id="media" width="64" height="64" loop muted playsinline src="/playing.webm"></video></div>
    <script>
      document.querySelector('#spa').onclick=()=>{history.pushState({},'', '/shorts/fixture');document.dispatchEvent(new Event('yt-navigate-finish'));};
      document.querySelector('#modal').onclick=()=>{const box=document.createElement('div');box.dataset.testid='shorts-player';document.body.append(box);box.append(document.querySelector('#media'));};
    </script></body></html>`;
const chrome = spawn(
  process.env.CHROME_PATH ??
    (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "google-chrome"),
  [
    "--headless=new",
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);
// A fake setup library at the test server's address, so the Library tab can be driven
// without the network. Every request to it is recorded.
const LIBRARY_HOST = "screenfry-library-test.bhron-site.workers.dev";
const libraryRequests = [];
const b64u = (text) => Buffer.from(text).toString("base64url");
// A real SF2 code: Reddit limited to 30 minutes a day.
const libraryCode = "SF2-j" + b64u(JSON.stringify({ r: { reddit: [0, 30] } }));
const libraryCard = {
  id: "reddit30",
  title: "Thirty minutes of Reddit",
  description: "Evenings only",
  websites: ["reddit"],
  tags: ["evenings"],
  summary: { blocked: [], limits: ["Reddit: 30 min a day"], windows: [], earnGoals: [], feedBlockers: 0, feedBlockingOn: true },
  upvotes: 3,
  createdAt: 0,
};
function fakeLibrary(request) {
  const url = new URL(request.url);
  libraryRequests.push({ method: request.method, path: url.pathname, query: url.search, headers: request.headers, body: request.postData });
  if (request.method === "OPTIONS") return [204, ""];
  if (request.method === "GET" && url.pathname === "/v1/setups") return [200, { setups: [libraryCard], next: null }];
  if (request.method === "GET" && url.pathname === "/v1/setups/reddit30") return [200, { ...libraryCard, code: libraryCode }];
  if (request.method === "POST" && url.pathname === "/v1/setups") return [201, { id: "published1" }];
  return [404, { error: "Not found." }];
}
let nextId = 0,
  buffer = "",
  chromeErrors = "";
const pending = new Map(),
  contexts = [];
chrome.stderr.on("data", (d) => {
  chromeErrors = (chromeErrors + d).slice(-2000);
});
function rejectPending(error) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}
chrome.on("error", rejectPending);
chrome.on("exit", () => rejectPending(Error("Chrome exited")));
chrome.stdio[4].on("data", (chunk) => {
  buffer += chunk.toString();
  let i;
  while ((i = buffer.indexOf("\0")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (msg.method === "Fetch.requestPaused" && new URL(msg.params.request.url).host === LIBRARY_HOST) {
      const [status, body] = fakeLibrary(msg.params.request);
      void cdp(
        "Fetch.fulfillRequest",
        {
          requestId: msg.params.requestId,
          responseCode: status,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Access-Control-Allow-Headers", value: "Content-Type, ScreenFry-Key, ScreenFry-Time, ScreenFry-Signature" },
            { name: "Access-Control-Allow-Methods", value: "GET, POST, PUT, DELETE, OPTIONS" },
          ],
          body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64"),
        },
        msg.sessionId,
      ).catch(() => {});
    } else if (msg.method === "Fetch.requestPaused") {
      const video =
        new URL(msg.params.request.url).pathname === "/playing.webm";
      void cdp(
        "Fetch.fulfillRequest",
        {
          requestId: msg.params.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: video ? "video/webm" : "text/html" },
          ],
          body: (video ? fixture : Buffer.from(fixtureHtml)).toString("base64"),
        },
        msg.sessionId,
      ).catch(() => {});
    }
    if (msg.method === "Runtime.executionContextCreated")
      contexts.push({ sessionId: msg.sessionId, ...msg.params.context });
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error
        ? p.reject(Error(JSON.stringify(msg.error)))
        : p.resolve(msg.result);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(Error(`Timed out: ${method}`));
      },
      method === "Extensions.loadUnpacked" || method === "Browser.getVersion"
        ? 60_000
        : 20_000,
    );
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(
      JSON.stringify({ id, method, params, sessionId }) + "\0",
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
function check(name, ok, detail = "") {
  checks.push(ok);
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? " — " + detail : ""}`,
  );
}
async function evaluate(sessionId, expression) {
  const r = await cdp(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails)
    throw Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}
const attach = async (id) =>
  (await cdp("Target.attachToTarget", { targetId: id, flatten: true }))
    .sessionId;
async function urlOf(id) {
  return (
    (await cdp("Target.getTargets")).targetInfos.find((t) => t.targetId === id)
      ?.url ?? ""
  );
}
async function open(url, { initScript, scriptsDisabled = false } = {}) {
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  const session = await attach(targetId);
  if (initScript) {
    await cdp("Page.enable", {}, session);
    await cdp(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: initScript },
      session,
    );
  }
  if (scriptsDisabled)
    await cdp("Emulation.setScriptExecutionDisabled", { value: true }, session);
  await cdp(
    "Fetch.enable",
    {
      patterns: [
        "youtube.com",
        "instagram.com",
        "example.com",
        "x.com",
        "reddit.com",
        "substack.com",
        "tiktok.com",
        LIBRARY_HOST,
      ].map((host) => ({
        urlPattern: `https://${host}/*`,
        requestStage: "Request",
      })),
    },
    session,
  );
  await cdp("Page.navigate", { url }, session);
  await sleep(700);
  return { id: targetId, session };
}
async function waitFor(fn, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw Error(`Timed out waiting for ${label}`);
}
/** ScreenFry's on-page timers (in a closed shadow root, which CDP can still read). */
async function overlayView(session) {
  const { root } = await cdp("DOM.getDocument", { depth: -1, pierce: true }, session);
  const view = { stack: false, dot: false, lines: [], ids: {} };
  const cls = (n) => {
    const a = n.attributes ?? [];
    const i = a.indexOf("class");
    return i >= 0 ? a[i + 1] : "";
  };
  const text = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children ?? []).map(text).join(""));
  const inside = (n) => {
    const c = cls(n).split(" ");
    if (c.includes("stack")) {
      view.stack = c.includes("show");
      view.lines = (n.children ?? []).map((chip) => text(chip.children?.[0] ?? chip));
    }
    if (c.includes("dot")) {
      view.dot = c.includes("show");
      view.ids.dot = n.nodeId;
    }
    if (c.includes("hide")) view.ids.hide = n.nodeId;
    for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) inside(k);
  };
  const walk = (n) => {
    if (n.localName === "screenfry-overlay") for (const r of n.shadowRoots ?? []) inside(r);
    for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(k);
  };
  walk(root);
  return view;
}
/** Clicks the timers' "–" or dot, as a person would. */
async function clickOverlay(session, which) {
  const { ids } = await overlayView(session);
  const { object } = await cdp("DOM.resolveNode", { nodeId: ids[which] }, session);
  await cdp("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){this.click()}" }, session);
  await sleep(300);
}
const site = (path = "/watch?v=fixture") => `https://youtube.com${path}`;
const shots = join(root, "dist/screenshots");
mkdirSync(shots, { recursive: true });
async function screenshot(page, name, width = 1280, height = 1000) {
  if (process.env.CI && !process.env.CAPTURE_E2E_SCREENSHOTS) return;
  await cdp("Page.bringToFront", {}, page.session);
  await cdp(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    page.session,
  );
  const shot = await cdp(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    page.session,
  );
  writeFileSync(join(shots, name), Buffer.from(shot.data, "base64"));
}
let controller;
try {
  await cdp("Browser.getVersion");
  const { id: extId } = await cdp("Extensions.loadUnpacked", {
    path: join(root, "dist/chrome"),
  });
  check("extension loads", !!extId);
  // The welcome page opens once the background has read its state, so wait for it
  // rather than guessing how long a slow runner needs.
  const welcomeOpen = async () =>
    (await cdp("Target.getTargets")).targetInfos.some((t) => t.url.includes("onboarding.html"));
  check(
    "welcome page opens on install",
    await waitFor(welcomeOpen, "welcome page", 10000).catch(() => false),
  );
  controller = await open(`chrome-extension://${extId}/dashboard.html`);
  const send = (req) =>
    evaluate(
      controller.session,
      `chrome.runtime.sendMessage(${JSON.stringify(req)})`,
    );
  const getState = async () => (await send({ type: "GET_STATE" })).data;
  const body = () => evaluate(controller.session, "document.body.innerText");
  await waitFor(async () => /Websites/.test(await body()), "dashboard", 10000).catch(() => {});
  check(
    "website controls work without mandatory onboarding or PIN",
    /Websites/.test(await body()) &&
      !/Create.*PIN|sealproof|commitment/i.test(await body()),
  );
  // A fresh install offers the four presets; "✕ I'll choose my own settings" closes them for
  // good and says where they are.
  const presetsShown = () =>
    evaluate(controller.session, `document.querySelectorAll('.presets-dialog .preset-card').length`);
  try { await waitFor(async () => (await presetsShown()) === 4, "presets", 4000); } catch {}
  check(
    "presets pop up on a fresh install",
    (await presetsShown()) === 4 &&
      /Most popular[\s\S]*Strict mode[\s\S]*Chill mode[\s\S]*Short-free/.test(await body()) &&
      /Presets are ready-made setups/.test(await body()),
  );
  await screenshot(controller, "presets.png");
  await evaluate(controller.session, `document.querySelector('.presets-skip').click()`);
  try { await waitFor(async () => (await getState()).presetsOffered === true, "presets offered", 4000); } catch {}
  const later = () => evaluate(controller.session, `document.querySelector('.presets-later')?.innerText ?? ""`);
  check(
    "I'll choose my own settings closes the presets for good and says where they are",
    (await presetsShown()) === 0 &&
      (await getState()).presetsOffered === true &&
      /always here[\s\S]*Show me where[\s\S]*OK, thanks/i.test(await later()),
    await later(),
  );
  await screenshot(controller, "presets-later.png");
  await evaluate(controller.session, `[...document.querySelectorAll('.presets-later button')].find(b=>/Show me where/.test(b.textContent)).click()`);
  check(
    "Show me where points at the Presets button",
    (await later()) === "" &&
      (await evaluate(controller.session, `[...document.querySelectorAll('.page-head button')].some(b=>b.textContent.trim()==='Presets'&&b.classList.contains('glow'))`)),
  );
  check(
    "every registry launch site has a rule",
    (await getState()).rules.map((r) => r.id).join() ===
      "youtube,instagram,x,reddit,substack,tiktok,facebook,linkedin,quora",
  );
  check(
    "onboarding can complete without a password",
    (await send({ type: "COMPLETE_ONBOARDING" })).ok,
  );
  // Drive actual React controls, rather than only its message API.
  await evaluate(
    controller.session,
    `document.querySelector('#daily-limit').value='5';document.querySelector('#daily-limit').dispatchEvent(new Event('change',{bubbles:true}))`,
  );
  // The first change without a password suggests one; "Not now" carries on with it.
  await waitFor(
    () => evaluate(controller.session, `!!document.querySelector('.password-prompt')`),
    "first-change password prompt",
  );
  check(
    "first change suggests password protection and explains it",
    /Set up password/.test(await body()) && /Never adds time/.test(await body()),
  );
  await evaluate(
    controller.session,
    `[...document.querySelectorAll('.password-prompt button')].find(b=>b.textContent==='Not now').click()`,
  );
  await waitFor(
    async () =>
      (await getState()).rules.find((r) => r.id === "youtube").dailyAllowance
        ?.defaultMinutes === 5,
    "daily limit control",
  );
  check("daily limit selector persists five minutes", true);
  check(
    "the password prompt is shown only once",
    (await getState()).passwordPromptSeen === true &&
      (await evaluate(
        controller.session,
        `document.querySelector('#daily-limit').value='5';document.querySelector('#daily-limit').dispatchEvent(new Event('change',{bubbles:true}));new Promise(r=>setTimeout(()=>r(!document.querySelector('.password-prompt')),300))`,
      )),
  );
  await screenshot(controller, "websites.png");
  await evaluate(
    controller.session,
    `[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Windows').click()`,
  );
  await sleep(150);
  check(
    "separate Windows page explains allow and block windows",
    /allow window/i.test(await body()) && /block window/i.test(await body()),
  );
  await evaluate(
    controller.session,
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Add window')).click()`,
  );
  await sleep(100);
  check(
    "window form has day/time and website whitelist controls",
    await evaluate(
      controller.session,
      `!!document.querySelector('#window-start')&&document.querySelectorAll('.whitelist input').length===9`,
    ),
  );
  await screenshot(controller, "window-editor.png");
  await evaluate(
    controller.session,
    `(()=>{const input=document.querySelector('#window-name');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Evening break');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.whitelist input').click();})()`,
  );
  await sleep(100);
  await evaluate(
    controller.session,
    `document.querySelector('[role=dialog] form').requestSubmit()`,
  );
  await waitFor(
    async () =>
      (await getState()).windows.some((w) => w.label === "Evening break"),
    "window form save",
  );
  check(
    "window form saves its website whitelist with alias coverage",
    (await getState()).windows
      .find((w) => w.label === "Evening break")
      .domains.includes("youtu.be"),
  );
  const formWindow = (await getState()).windows.find(
    (w) => w.label === "Evening break",
  );
  await send({ type: "DELETE_WINDOW", windowId: formWindow.id });

  // The setup library: off by default, and nothing contacts it until it's turned on.
  const clickText = (session, selector, text) =>
    evaluate(
      session,
      `(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}));if(!b)return false;b.click();return true})()`,
    );
  await clickText(controller.session, "nav button", "Share");
  await sleep(150);
  await clickText(controller.session, "[role=tab]", "Library");
  await sleep(300);
  const popupPage = await open(`chrome-extension://${extId}/popup.html`);
  await sleep(500);
  check(
    "the setup library is off by default and nothing contacts it",
    libraryRequests.length === 0 && /Turn on the library/.test(await body()),
  );
  await cdp("Target.closeTarget", { targetId: popupPage.id });
  await clickText(controller.session, "button", "Turn on the library");
  await waitFor(async () => /Thirty minutes of Reddit/.test(await body()), "library results");
  check(
    "turning the library on searches it, sending no settings",
    (await getState()).libraryEnabled === true &&
      libraryRequests.every((r) => r.method !== "GET" || (!r.body && !r.headers["ScreenFry-Key"])),
  );
  await clickText(controller.session, ".library-card-head", "");
  await waitFor(() => evaluate(controller.session, `!!document.querySelector('.library-detail .share-slides')`), "library preview slides");
  await clickText(controller.session, ".library-detail [role=tab]", "Loadout 3");
  await waitFor(
    async () => /Use in Loadout 3/.test(await body()),
    "library apply button for loadout 3",
  );
  check("a library setup previews with the share slides", /This setup makes/.test(await body()));
  await screenshot(controller, "library.png");
  await clickText(controller.session, ".library-detail button", "Use in Loadout 3");
  await waitFor(
    async () => (await getState()).loadouts?.[2]?.rules?.find((r) => r.id === "reddit" || r.domains.includes("reddit.com"))?.dailyAllowance?.defaultMinutes === 30,
    "library setup in loadout 3",
  );
  check("Use in loadout puts a library setup in that loadout, not the live settings", !(await getState()).rules.find((r) => r.domains.includes("reddit.com"))?.dailyAllowance);
  // Publishing shows what becomes public and sends only the code, title, description and tags.
  await clickText(controller.session, "[role=tab]", "Loadouts");
  await sleep(150);
  await clickText(controller.session, ".loadout-tabs .loadout-tab", "Loadout 3");
  await sleep(150);
  await clickText(controller.session, "button", "Publish to library");
  await waitFor(() => evaluate(controller.session, `!!document.querySelector('.publish-dialog')`), "publish dialog");
  await evaluate(
    controller.session,
    `(()=>{const d=document.querySelector('.publish-dialog');const t=d.querySelector('input:not([type=checkbox])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(t,'My Reddit plan');t.dispatchEvent(new Event('input',{bubbles:true}));d.querySelector('input[type=checkbox]').click();})()`,
  );
  await sleep(100);
  check("the publish dialog lists what becomes public", /Everyone will see/.test(await body()) && /Reddit/.test(await body()));
  await screenshot(controller, "library-publish.png");
  await evaluate(controller.session, `document.querySelector('.publish-dialog form').requestSubmit()`);
  await waitFor(async () => /Published\./.test(await body()), "published");
  const published = libraryRequests.find((r) => r.method === "POST" && r.path === "/v1/setups");
  check(
    "publishing sends only the setup, signed with the install key",
    published &&
      JSON.stringify(Object.keys(JSON.parse(published.body)).sort()) === JSON.stringify(["code", "description", "tags", "title"]) &&
      JSON.parse(published.body).title === "My Reddit plan" &&
      !/usage|password|history/i.test(published.body) &&
      Boolean(published.headers["ScreenFry-Key"] && published.headers["ScreenFry-Signature"]),
  );
  await clickText(controller.session, ".publish-dialog button", "Done");
  // Turning it off stops requests (the key is kept here, so the second question is answered no).
  await clickText(controller.session, "[role=tab]", "Library");
  await sleep(200);
  await clickText(controller.session, "button", "Turn off the library");
  await sleep(150);
  await clickText(controller.session, ".loosen-dialog button", "Turn off");
  await sleep(300);
  await clickText(controller.session, ".loosen-dialog button", "Keep it");
  await waitFor(async () => (await getState()).libraryEnabled !== true, "library off");
  const before = libraryRequests.length;
  await clickText(controller.session, "[role=tab]", "Loadouts");
  await sleep(150);
  await clickText(controller.session, "[role=tab]", "Library");
  await sleep(500);
  check("turning the library off stops every request", libraryRequests.length === before && /Turn on the library/.test(await body()));
  await clickText(controller.session, "nav button", "Websites");
  await sleep(150);
  const rule = (id, domain, minutes) => ({
    id,
    label: id,
    domains: [domain],
    enabled: true,
    blocked: false,
    showTimer: false,
    dailyAllowance:
      minutes === undefined ? undefined : { defaultMinutes: minutes },
    createdAt: 0,
    updatedAt: 0,
  });
  check(
    "daily restriction saves with no PIN",
    (await send({ type: "SAVE_RULE", rule: rule("example", "example.com", 0) }))
      .ok,
  );
  const blocked = await open("https://example.com/direct");
  await waitFor(
    async () => (await urlOf(blocked.id)).includes("blocked.html"),
    "daily limit redirect",
  );
  check("zero allowance redirects a direct URL to blocked page", true);
  const blockedText = await evaluate(
    blocked.session,
    "document.body.innerText",
  );
  check(
    "blocked page offers no PIN, temporary visit or bypass",
    !/PIN|temporary visit|unlock|10.minute/i.test(blockedText),
  );
  check(
    "old override message is rejected",
    !(await send({ type: "VERIFY_AND_OVERRIDE", url: site(), pin: "123456" }))
      .ok,
  );
  const now = new Date(),
    day = now.getDay(),
    minute = now.getHours() * 60 + now.getMinutes();
  // Use a window tomorrow so this remains stable around midnight and DST.
  const w = {
    id: "fixture-window",
    label: "Tomorrow break",
    enabled: true,
    domains: ["youtube.com"],
    days: [(day + 1) % 7],
    startMinute: 0,
    endMinute: 0,
  };
  check(
    "window can be saved independently of an allowance",
    (await send({ type: "SAVE_WINDOW", window: w })).ok,
  );
  const outside = await open(site());
  await waitFor(
    async () => (await urlOf(outside.id)).includes("blocked.html"),
    "outside window redirect",
  );
  check("outside-window block applies with daily time remaining", true);
  await screenshot(controller, "windows.png");
  check(
    "another allowed window can open the site without resetting its limit",
    (
      await send({
        type: "SAVE_WINDOW",
        window: { ...w, id: "today", days: [day] },
      })
    ).ok,
  );
  const normal = await open(site());
  check(
    "normal content is available inside any matching window",
    await evaluate(normal.session, `!!document.querySelector('#spa')`),
  );
  await send({ type: "DELETE_WINDOW", windowId: w.id });
  await send({ type: "DELETE_WINDOW", windowId: "today" });
  let feeds = (await getState()).feedSettings;
  feeds.sites.youtube.shorts = true;
  feeds.sites.instagram.reels = true;
  check(
    "Shorts and Reels controls save",
    (await send({ type: "SET_FEEDS", feedSettings: feeds })).ok,
  );
  const styleChurn = await open(site());
  const timerDelay = await evaluate(
    styleChurn.session,
    `new Promise(resolve=>{
      const observer=new MutationObserver(()=>document.getElementById('screenfry-feed-blocker')?.remove());
      observer.observe(document.head,{childList:true});
      document.getElementById('screenfry-feed-blocker')?.remove();
      const start=performance.now();
      setTimeout(()=>{observer.disconnect();resolve(performance.now()-start)},200);
    })`,
  );
  check(
    "page timers remain responsive when a website repeatedly removes injected styles",
    timerDelay < 1500,
  );
  await cdp("Target.closeTarget", { targetId: styleChurn.id });
  for (const [name, url] of [
    ["Shorts notification", site("/shorts/fixture?feature=notification")],
    ["individual Reel", "https://instagram.com/reel/fixture"],
    ["Reels feed", "https://instagram.com/reels/"],
  ]) {
    const tab = await open(url);
    await waitFor(
      async () => (await urlOf(tab.id)).includes("blocked.html"),
      name,
    );
    check(`${name} is blocked entirely`, true);
  }
  const spa = await open(site());
  if (process.env.DEBUG_E2E)
    console.log(
      "SPA PAGE",
      await urlOf(spa.id),
      await evaluate(spa.session, "document.body.innerText"),
    );
  await evaluate(spa.session, `document.querySelector('#spa').click()`);
  await waitFor(
    async () => (await urlOf(spa.id)).includes("blocked.html"),
    "SPA short-form route",
  );
  check("SPA navigation into Shorts is blocked", true);
  const modal = await open(site());
  await evaluate(modal.session, `document.querySelector('#modal').click()`);
  await waitFor(
    async () =>
      await evaluate(
        modal.session,
        `!!document.querySelector('screenfry-blocked') && document.querySelector('#media').paused`,
      ),
    "short-form modal",
  );
  check("short-form player modal is blocked even without a Shorts URL", true);
  feeds = (await getState()).feedSettings;
  feeds.sites.youtube.shortsFromLinks = true;
  await send({ type: "SET_FEEDS", feedSettings: feeds });
  const linkedShort = await open(site("/shorts/linked"));
  await sleep(600);
  const blockedHere = (page) =>
    evaluate(page.session, `!!document.querySelector('screenfry-blocked')`);
  check(
    "research mode plays a Short opened from a link",
    !(await urlOf(linkedShort.id)).includes("blocked.html") &&
      !(await blockedHere(linkedShort)),
  );
  const go = (path) =>
    evaluate(
      linkedShort.session,
      `history.pushState({},'', '${path}');document.dispatchEvent(new Event('yt-navigate-finish'))`,
    );
  await go("/shorts/next");
  await waitFor(() => blockedHere(linkedShort), "research mode: the next Short");
  check(
    "research mode stops the next Short and says it's going home",
    true,
  );
  await go("/shorts/linked");
  await waitFor(async () => !(await blockedHere(linkedShort)), "back to the linked Short");
  check("research mode lets you back to the linked Short", true);
  await go("/@creator");
  await waitFor(
    async () => (await urlOf(linkedShort.id)) === "https://youtube.com/",
    "research mode: home after the creator's page",
    8000,
  );
  await sleep(700);
  check(
    "research mode moves on to the website's home page, which opens normally",
    !(await blockedHere(linkedShort)),
  );
  await cdp("Target.closeTarget", { targetId: linkedShort.id });
  feeds.sites.youtube.shortsFromLinks = false;
  await send({ type: "SET_FEEDS", feedSettings: feeds });
  feeds = (await getState()).feedSettings;
  feeds.sites.youtube.shorts = false;
  await send({ type: "SET_FEEDS", feedSettings: feeds });
  const off = await open(site("/shorts/fixture"));
  check(
    "disabling Shorts setting restores ordinary access",
    !(await urlOf(off.id)).includes("blocked.html"),
  );
  // Actual muted video: playback is invisible to tabs.audible and must use media-state reporting.
  const mediaUrl = site("/watch?v=background-media");
  const media = await open(mediaUrl);
  await evaluate(media.session, `document.querySelector('#media').play()`);
  await sleep(500);
  await cdp("Target.activateTarget", { targetId: controller.id });
  await waitFor(async () => {
    const s = await evaluate(
      controller.session,
      `chrome.storage.session.get('trackingSessionsV3')`,
    );
    return s.trackingSessionsV3?.some((t) => t.url === mediaUrl);
  }, "background video session");
  check(
    "muted video continues counting after its tab goes into the background",
    true,
  );
  await evaluate(media.session, `document.querySelector('#media').pause()`);
  // Playback changes settle for a moment before usage is checkpointed.
  check(
    "paused background tabs stop counting",
    await waitFor(async () => {
      const tracked = await evaluate(
        controller.session,
        `chrome.storage.session.get('trackingSessionsV3')`,
      );
      return !tracked.trackingSessionsV3.some((t) => t.url === mediaUrl);
    }, "paused tab to stop counting", 4000),
  );
  for (const host of ["x.com", "reddit.com", "substack.com"]) {
    const key = host.split(".")[0];
    let controls = (await getState()).feedSettings;
    controls.sites[key].videos = true;
    await send({ type: "SET_FEEDS", feedSettings: controls });
    const videoPage = await open(`https://${host}/watch?fixture=video`);
    await evaluate(
      videoPage.session,
      `document.querySelector('#media').play().catch(()=>{})`,
    );
    await sleep(150);
    check(
      `${key} video control suppresses actual playback`,
      await evaluate(
        videoPage.session,
        `document.querySelector('#media').paused`,
      ),
    );
    controls = (await getState()).feedSettings;
    controls.sites[key].videos = false;
    await send({ type: "SET_FEEDS", feedSettings: controls });
    await evaluate(
      videoPage.session,
      `document.querySelector('#media').play()`,
    );
    check(
      `${key} playback is available when its control is off`,
      await evaluate(
        videoPage.session,
        `!document.querySelector('#media').paused`,
      ),
    );
    await cdp("Target.closeTarget", { targetId: videoPage.id });
  }
  {
    // Reddit's "Suggested videos" end screen, in the page and inside its player's shadow root.
    const panel = `<div class="overlay-header"><div>Suggested videos</div><button>Close</button></div><div class="overlay-recommendations"><a href="/r/a/comments/1/b/">A video</a></div>`;
    const reddit = await open("https://reddit.com/r/videos/comments/fixture/video/");
    await evaluate(
      reddit.session,
      `customElements.define('shreddit-player-2', class extends HTMLElement {
         constructor(){ super(); this.attachShadow({mode:'open'}).innerHTML = '<div id="end">${panel}</div>'; }
       });
       document.body.insertAdjacentHTML('beforeend', '<div id="light">${panel}</div><shreddit-player-2></shreddit-player-2>');`,
    );
    const hidden = () =>
      evaluate(
        reddit.session,
        `(() => {
           const shadow = document.querySelector('shreddit-player-2').shadowRoot;
           const gone = (el) => !el || getComputedStyle(el).display === 'none';
           return [document.querySelector('#light > .overlay-recommendations'), document.querySelector('#light > .overlay-header'),
                   shadow.querySelector('#end > .overlay-recommendations'), shadow.querySelector('#end > .overlay-header')].map(gone);
         })()`,
      );
    let controls = (await getState()).feedSettings;
    controls.sites.reddit.suggestedVideos = true;
    await send({ type: "SET_FEEDS", feedSettings: controls });
    let ok = false;
    try {
      ok = await waitFor(async () => (await hidden()).every(Boolean), "suggested videos hidden", 4000);
    } catch {}
    check("reddit suggested videos are hidden, inside the player too", ok, JSON.stringify(await hidden()));
    controls = (await getState()).feedSettings;
    controls.sites.reddit.suggestedVideos = false;
    await send({ type: "SET_FEEDS", feedSettings: controls });
    ok = false;
    try {
      ok = await waitFor(async () => (await hidden()).every((h) => !h), "suggested videos back", 4000);
    } catch {}
    check("reddit suggested videos come back when the control is off", ok, JSON.stringify(await hidden()));
    await cdp("Target.closeTarget", { targetId: reddit.id });
  }
  {
    // A site that restarts a video the moment it is paused (Explore pages do) must not keep
    // ScreenFry and the page answering each other without end.
    let controls = (await getState()).feedSettings;
    controls.sites.x.videos = true;
    await send({ type: "SET_FEEDS", feedSettings: controls });
    const stubborn = await open("https://x.com/watch?fixture=stubborn");
    const plays = await evaluate(
      stubborn.session,
      `new Promise((done)=>{const m=document.querySelector('#media');let plays=0;
        m.addEventListener('play',()=>plays++);
        m.addEventListener('pause',()=>m.play().catch(()=>{}));
        m.play().catch(()=>{});
        setTimeout(()=>done({plays, muted:m.muted}),3000);})`,
    );
    check(
      "a page restarting a blocked video is answered at most about once a second",
      plays.plays <= 10 && plays.muted,
    );
    controls = (await getState()).feedSettings;
    controls.sites.x.videos = false;
    await send({ type: "SET_FEEDS", feedSettings: controls });
    await cdp("Target.closeTarget", { targetId: stubborn.id });
  }
  // Content scripts cannot make privileged settings changes, even when password protection is off.
  const tiktok = await open("https://tiktok.com/@fixture/video/123");
  await evaluate(
    tiktok.session,
    `
    window.documentMarker='same-document';
    const recommendations=document.createElement('aside');recommendations.dataset.e2e='recommend-video-list';recommendations.textContent='You may like';document.body.append(recommendations);
    const comments=document.createElement('div');comments.dataset.e2e='comment-list';comments.textContent='Comments';document.body.append(comments);
    document.querySelector('#regular-player').dataset.e2e='browse-video';
  `,
  );
  feeds = (await getState()).feedSettings;
  feeds.sites.tiktok.recommendedVideos = true;
  feeds.sites.tiktok.singleVideo = true;
  await send({ type: "SET_FEEDS", feedSettings: feeds });
  await waitFor(
    async () =>
      await evaluate(
        tiktok.session,
        `getComputedStyle(document.querySelector('[data-e2e="recommend-video-list"]')).display==='none'`,
      ),
    "live TikTok recommendations",
  );
  check(
    "TikTok settings apply live without reloading the document",
    await evaluate(tiktok.session, `window.documentMarker==='same-document'`),
  );
  check(
    "linked-video mode blocks player scrolling but preserves comment scrolling",
    await evaluate(
      tiktok.session,
      `
    !document.querySelector('#media').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100})) &&
    document.querySelector('[data-e2e="comment-list"]').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100}))
  `,
    ),
  );
  await evaluate(
    tiktok.session,
    `history.pushState({},'', '/@fixture/video/456');document.querySelector('#media').play().catch(()=>{})`,
  );
  await waitFor(
    async () =>
      await evaluate(
        tiktok.session,
        `!!document.querySelector('screenfry-blocked') && document.querySelector('#media').paused`,
      ),
    "single video navigation guard",
  );
  check("scrolling/SPA navigation cannot play a second TikTok", true);
  await screenshot(tiktok, "tiktok-linked-video.png");
  feeds.sites.tiktok.singleVideo = false;
  feeds.sites.tiktok.recommendedVideos = false;
  await send({ type: "SET_FEEDS", feedSettings: feeds });
  await waitFor(
    async () =>
      await evaluate(
        tiktok.session,
        `!document.querySelector('screenfry-blocked') && getComputedStyle(document.querySelector('[data-e2e="recommend-video-list"]')).display!=='none'`,
      ),
    "live TikTok restoration",
  );
  check("disabling TikTok controls restores the page live", true);
  const workerTarget = (await cdp("Target.getTargets")).targetInfos.find(
    (t) =>
      t.type === "service_worker" &&
      t.url.startsWith(`chrome-extension://${extId}/`),
  );
  if (!workerTarget) throw Error("Extension worker not found");
  const workerSession = await attach(workerTarget.targetId);
  const tiktokTabId = await evaluate(
    controller.session,
    `chrome.tabs.query({url:'https://tiktok.com/*'}).then(tabs=>tabs[0].id)`,
  );
  await evaluate(
    workerSession,
    `
    globalThis.originalTabSend=chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage=(id,message,...args)=>{
      if(id===${tiktokTabId} && message.type==='SCREENFRY_APPLY_SETTINGS') return Promise.reject(new Error('Fixture: stale content script'));
      return originalTabSend(id,message,...args);
    };
  `,
  );
  feeds.sites.tiktok.recommendedVideos = true;
  await send({ type: "SET_FEEDS", feedSettings: feeds });
  await waitFor(
    async () =>
      await evaluate(tiktok.session, `window.documentMarker===undefined`),
    "fallback refresh",
  );
  check(
    "a missing live-update responder triggers a single automatic refresh",
    true,
  );
  await evaluate(workerSession, `chrome.tabs.sendMessage=originalTabSend`);
  await cdp("Target.closeTarget", { targetId: tiktok.id });

  {
    // Websites → Presets opens them again; Chill mode gives every website an hour a day, and
    // the setup before it is kept in an empty loadout.
    await evaluate(controller.session, `location.hash='#websites';location.reload()`);
    await sleep(1500);
    await evaluate(controller.session, `[...document.querySelectorAll('.page-head button')].find(b=>b.textContent.trim()==='Presets').click()`);
    let opened = false;
    try { opened = await waitFor(async () => (await presetsShown()) === 4, "presets reopened", 4000); } catch {}
    check("the Presets button opens the presets again", opened);
    await evaluate(controller.session, `[...document.querySelectorAll('.preset-card button')].find(b=>/Chill mode/.test(b.textContent)).click()`);
    try {
      await waitFor(() => evaluate(controller.session, `!!document.querySelector('.loosen-dialog')`), "confirm", 4000);
    } catch {}
    await evaluate(controller.session, `document.querySelector('.loosen-dialog .danger-fill').click()`);
    let chill;
    try {
      await waitFor(async () => (chill = await getState()).rules.filter((r) => r.dailyAllowance?.defaultMinutes === 60).length >= 9, "Chill mode", 5000);
    } catch {}
    chill ??= await getState();
    const saved = chill.loadouts?.findIndex((l, i) => l && i !== (chill.activeLoadout ?? 0));
    check(
      "Chill mode gives every website an hour a day, keeping the old setup in a loadout",
      chill.rules.filter((r) => r.dailyAllowance?.defaultMinutes === 60).length >= 9 && saved >= 0,
      JSON.stringify({ limits: chill.rules.map((r) => r.dailyAllowance?.defaultMinutes), saved }),
    );
    // Back to the setup the rest of this test expects.
    if (saved >= 0) await send({ type: "SWITCH_LOADOUT", index: saved });
  }

  {
    // The Earn page: a goal that pays out 3 times a day shows its tally beside the bar.
    const goal = { id: "tally", label: "UWorld", enabled: true, goalDomains: ["example.org"], minutes: 60, lockedDomains: ["youtube.com"], reward: "fry", fryMinutes: 3, repeats: 3 };
    const saved = await send({ type: "SAVE_EARN_GOAL", goal });
    await evaluate(controller.session, `location.hash='#earn';location.reload()`);
    let tally = "";
    try {
      await waitFor(async () => /0\/3 earned/.test((tally = await evaluate(controller.session, `document.querySelector('.earn-tally')?.textContent ?? ""`))), "tally", 4000);
    } catch {}
    check(
      "the Earn page shows a repeating goal's tally beside its bar (0/3 earned)",
      saved.ok && /0\/3 earned/.test(tally) &&
        (await evaluate(controller.session, `document.querySelectorAll('.earn-tally .earn-pips > span').length`)) === 3,
      JSON.stringify({ saved, tally }),
    );
    await screenshot(controller, "earn-tally-page.png");
    await send({ type: "DELETE_EARN_GOAL", goalId: "tally" });
  }
  // Exercise the Safari-style local screen with a deliberately unresponsive background.
  // This is a runtime fixture, not evidence of live Safari acceptance.
  await send({ type: "DELETE_RULE", ruleId: "example" });
  const inline = await open("https://example.com/inline-block");
  const { frameTree } = await cdp("Page.getFrameTree", {}, inline.session);
  const { executionContextId } = await cdp(
    "Page.createIsolatedWorld",
    { frameId: frameTree.frame.id, worldName: "screenfry-inline-test" },
    inline.session,
  );
  const inlineState = await getState();
  inlineState.rules.push(rule("example", "example.com", 1));
  const dateKey = "2026-11-08";
  inlineState.usage[dateKey] = {
    dateKey,
    millisecondsByRule: { example: 60000 },
    warningsSent: {},
  };
  const isolated = async (expression) => {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression,
        contextId: executionContextId,
        awaitPromise: true,
        returnByValue: true,
      },
      inline.session,
    );
    if (result.exceptionDetails)
      throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  // Use the browser's local date to keep this fixture portable across machines.
  await isolated(`
    window.testState=${JSON.stringify(inlineState)};
    window.fakeNow=new Date(2026,10,8,23,59,59).getTime();Date.now=()=>window.fakeNow;
    window.messages=0;
    window.chrome={storage:{local:{get:async()=>({screenfryState:window.testState})},onChanged:{addListener:fn=>window.stateChanged=fn}},runtime:{getURL:path=>'chrome-extension://${extId}/'+path,sendMessage:()=>{window.messages++;return new Promise(()=>{})},onMessage:{addListener:fn=>window.applySettings=fn}}};
    const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){return attach.call(this,{...options,mode:'open'})};
  `);
  await isolated(
    readFileSync(join(root, "dist/chrome/assets/content.js"), "utf8"),
  );
  await waitFor(
    async () =>
      await evaluate(
        inline.session,
        `document.querySelector('screenfry-blocked')?.shadowRoot.querySelector('h1').textContent==='Time is up!'`,
      ),
    "inline time-up screen",
  );
  check(
    "time-up screen renders without waiting for background navigation",
    await evaluate(
      inline.session,
      `document.querySelector('screenfry-blocked').shadowRoot.querySelector('dialog').open && location.pathname==='/inline-block'`,
    ),
  );
  await screenshot(inline, "time-up-inline.png");
  check(
    "blocked page stays responsive and does not flood background messages",
    await isolated(
      `new Promise(resolve=>setTimeout(()=>resolve(window.messages<4),250))`,
    ),
  );
  await isolated(`window.fakeNow=new Date(2026,10,9,0,0,1).getTime()`);
  await waitFor(
    async () =>
      await evaluate(
        inline.session,
        `!document.querySelector('screenfry-blocked')`,
      ),
    "midnight inline recovery",
  );
  check(
    "daily limit resets at local midnight without a background reply or reload",
    true,
  );
  {
    // "Display timer on site": the daily limit's countdown shows on the website, and "–"
    // shrinks it to a dot that the website reopens with.
    const timed = { ...rule("timed", "example.com", 30), showTimer: true };
    await send({ type: "SAVE_RULE", rule: timed });
    const page = await open("https://example.com/timed");
    let view = {};
    const showing = async (pattern) => {
      try {
        await waitFor(async () => (view = await overlayView(page.session)).stack && view.lines.some((l) => pattern.test(l)), "timer", 5000);
        return true;
      } catch {
        return false;
      }
    };
    check("limit timer shows on the website", await showing(/^timed · \d+:\d\d left today$/), JSON.stringify(view));
    await clickOverlay(page.session, "hide");
    view = await overlayView(page.session);
    check("limit timer minimizes to a dot", !view.stack && view.dot, JSON.stringify(view));
    await cdp("Page.reload", {}, page.session);
    await sleep(1500);
    let reopened = false;
    try {
      reopened = await waitFor(async () => (view = await overlayView(page.session)).dot && !view.stack, "minimized after reload", 5000);
    } catch {}
    check("a minimized timer stays a dot when the website reopens", reopened, JSON.stringify(view));
    await clickOverlay(page.session, "dot");
    // No daily limit: the timer shows time used today instead of doing nothing.
    await send({ type: "SAVE_RULE", rule: { ...timed, dailyAllowance: undefined } });
    check("without a limit the timer shows time used today", await showing(/^timed · \d+:\d\d today$/), JSON.stringify(view));
    await send({ type: "DELETE_RULE", ruleId: "timed" });
    await cdp("Target.closeTarget", { targetId: page.id });
  }
  {
    // A website with both a limit timer and Fry Time shows both: Fry Time never lifts a limit.
    let feeds = (await getState()).feedSettings;
    feeds.sites.reddit.home = true;
    await send({ type: "SET_FEEDS", feedSettings: feeds });
    await send({ type: "SAVE_RULE", rule: { ...rule("reddit", "reddit.com", 60), label: "Reddit", showTimer: true } });
    const fry = { id: "fry-all-day", label: "Fry", enabled: true, domains: ["reddit.com"], days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 0, mode: "free", freeMinutes: 30 };
    await send({ type: "SAVE_WINDOW", window: fry });
    const page = await open("https://reddit.com/");
    let view = {};
    let both = false;
    try {
      both = await waitFor(async () => {
        view = await overlayView(page.session);
        return view.lines.some((l) => /^Fry Time · \d+:\d\d left$/.test(l)) && view.lines.some((l) => /^Reddit · \d+:\d\d left today$/.test(l));
      }, "Fry Time and limit timers", 5000);
    } catch {}
    check("a limit timer and Fry Time show together", both, JSON.stringify(view));
    await send({ type: "DELETE_WINDOW", windowId: fry.id });
    await send({ type: "SAVE_RULE", rule: { ...rule("reddit", "reddit.com"), label: "Reddit" } });
    feeds = (await getState()).feedSettings;
    feeds.sites.reddit.home = false;
    await send({ type: "SET_FEEDS", feedSettings: feeds });
    await cdp("Target.closeTarget", { targetId: page.id });
  }
  {
    // The Earn counter on a goal website: shown, hidden by its setting, and in the same stack.
    const page = await open("https://example.com/earn-goal");
    const { frameTree: earnFrames } = await cdp("Page.getFrameTree", {}, page.session);
    const { executionContextId: earnContext } = await cdp(
      "Page.createIsolatedWorld",
      { frameId: earnFrames.frame.id, worldName: "screenfry-earn-test" },
      page.session,
    );
    const inWorld = async (expression) => {
      const result = await cdp(
        "Runtime.evaluate",
        { expression, contextId: earnContext, awaitPromise: true, returnByValue: true },
        page.session,
      );
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const earnState = await getState();
    earnState.earnGoals = [
      { id: "lang", label: "Duolingo", enabled: true, goalDomains: ["example.com"], minutes: 10, lockedDomains: ["youtube.com"], reward: "unlock" },
    ];
    await inWorld(`
      window.testState=${JSON.stringify(earnState)};
      window.saved=[];window.changed=[];
      window.chrome={storage:{local:{get:async(keys)=>({screenfryState:window.testState}),set:async(v)=>{window.saved.push(v)}},onChanged:{addListener:fn=>window.changed.push(fn)}},runtime:{getURL:path=>'chrome-extension://${extId}/'+path,sendMessage:()=>new Promise(()=>{}),onMessage:{addListener:()=>{}}}};
    `);
    await inWorld(readFileSync(join(root, "dist/chrome/assets/content.js"), "utf8"));
    let view = {};
    let ok = false;
    try {
      ok = await waitFor(async () => (view = await overlayView(page.session)).stack && /^Earning|^Paused/.test(view.lines[0] ?? ""), "Earn counter", 4000);
    } catch {}
    check("earn counter shows on the goal website", ok && /Duolingo · \d+:\d\d of 10:00/.test(view.lines[0]), JSON.stringify(view));
    await screenshot(page, "earn-counter.png", 900, 300);
    await clickOverlay(page.session, "hide");
    view = await overlayView(page.session);
    check(
      "earn counter minimizes to a dot, remembered for this website",
      !view.stack && view.dot && (await inWorld(`window.saved.some(v=>v['screenfry.timersMinimized']?.['example.com']===true)`)),
      JSON.stringify(view),
    );
    await screenshot(page, "earn-dot.png", 900, 300);
    await sleep(1200);
    view = await overlayView(page.session);
    check("a minimized earn counter stays a dot as the clock ticks", !view.stack && view.dot);
    await clickOverlay(page.session, "dot");
    view = await overlayView(page.session);
    check("the dot brings the earn counter back", view.stack && !view.dot, JSON.stringify(view));
    // Minimizing in another tab of this website follows here; another website's choice doesn't.
    await inWorld(`window.changed.forEach(fn=>fn({'screenfry.timersMinimized':{newValue:{'youtube':true}}},'local'))`);
    view = await overlayView(page.session);
    check("another website's minimized timers don't affect this one", view.stack && !view.dot, JSON.stringify(view));
    await inWorld(`window.changed.forEach(fn=>fn({'screenfry.timersMinimized':{newValue:{'example.com':true}}},'local'))`);
    view = await overlayView(page.session);
    check("minimizing the timers in another tab follows here", !view.stack && view.dot, JSON.stringify(view));
    // Settings → "Earn counter on websites" off hides it.
    await inWorld(`window.testState={...window.testState,showEarnCounter:false};window.changed.forEach(fn=>fn({screenfryState:{newValue:window.testState}},'local'))`);
    try {
      ok = await waitFor(async () => {
        view = await overlayView(page.session);
        return !view.stack && !view.dot;
      }, "earn counter hidden", 4000);
    } catch {
      ok = false;
    }
    check("the Earn counter setting hides it", ok, JSON.stringify(view));
    // A Fry Time goal that pays out 3 times a day says how many it has earned: 15 minutes
    // into 10-minute steps is 1 of 3, with 5:00 toward the next.
    await inWorld(`
      const d=new Date(),key=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      window.testState={...window.testState,showEarnCounter:true,usageAsOf:undefined,
        earnGoals:[{id:'lang',label:'UWorld',enabled:true,goalDomains:['example.com'],minutes:10,lockedDomains:['youtube.com'],reward:'fry',fryMinutes:3,repeats:3}],
        usage:{[key]:{dateKey:key,millisecondsByRule:{},warningsSent:{},millisecondsByWindow:{},millisecondsByGoal:{lang:15*60000}}}};
      window.changed.forEach(fn=>fn({'screenfry.timersMinimized':{newValue:{}}},'local'));
      window.changed.forEach(fn=>fn({screenfryState:{newValue:window.testState}},'local'))`);
    try {
      ok = await waitFor(async () => / · 1\/3 earned/.test((view = await overlayView(page.session)).lines?.[0] ?? ""), "earn tally", 4000);
    } catch {
      ok = false;
    }
    check("a repeating earn goal shows how many times it's earned today (1/3)", ok && /UWorld · 5:00 of 10:00 · 1\/3 earned/.test(view.lines[0]), JSON.stringify(view));
    await screenshot(page, "earn-tally.png", 900, 300);
    await cdp("Target.closeTarget", { targetId: page.id });
  }
  await cdp("Target.closeTarget", { targetId: inline.id });

  await cdp("Runtime.enable", {}, media.session);
  await sleep(100);
  const iso = contexts.find(
    (c) =>
      c.sessionId === media.session &&
      c.auxData?.type === "isolated" &&
      c.origin === `chrome-extension://${extId}`,
  );
  if (!iso) throw new Error("ScreenFry content-script world not found");
  const forbidden = await cdp(
    "Runtime.evaluate",
    {
      expression: `chrome.runtime.sendMessage({type:'DELETE_RULE',ruleId:'youtube'})`,
      contextId: iso.id,
      awaitPromise: true,
      returnByValue: true,
    },
    media.session,
  );
  check(
    "web-page content scripts cannot edit settings",
    forbidden.result.value?.ok === false,
  );
  const pass = "isolated test password";
  check(
    "optional settings password can be enabled",
    (await send({ type: "SET_SETTINGS_PASSWORD", newPassword: pass })).ok,
  );
  check(
    "password protects site changes",
    !(
      await send({
        type: "SAVE_RULE",
        rule: rule("youtube", "youtube.com", 60),
      })
    ).ok,
  );
  check(
    "password protects window changes",
    !(await send({ type: "SAVE_WINDOW", window: w })).ok,
  );
  check(
    "wrong settings password is rejected",
    !(await send({ type: "UNLOCK_SETTINGS", password: "wrong" })).ok,
  );
  check(
    "correct settings password authorizes changes",
    (
      await send({
        type: "SAVE_RULE",
        rule: rule("youtube", "youtube.com", 30),
        password: pass,
      })
    ).ok,
  );
  await cdp("Page.reload", {}, controller.session);
  await sleep(500);
  check(
    "reloading the dashboard shows the password gate",
    /Settings are protected/.test(await body()),
  );
  check(
    "protection never stores the plaintext password",
    !JSON.stringify(await getState()).includes(pass),
  );
  check(
    "authenticated user can turn password protection off",
    (
      await send({
        type: "SET_SETTINGS_PASSWORD",
        newPassword: "",
        password: pass,
      })
    ).ok,
  );
  await sleep(150);
  await evaluate(
    controller.session,
    `[...document.querySelectorAll('nav button')].find(b=>b.textContent==='Settings').click()`,
  );
  await sleep(150);
  await screenshot(controller, "settings.png");
  const popup = await open(`chrome-extension://${extId}/popup.html`);
  await screenshot(popup, "popup.png", 400, 900);
  check(
    "popup offers every website",
    await evaluate(
      popup.session,
      `document.querySelectorAll('#site-picker [role=option]').length===9`,
    ),
  );
  const shell = await open(`chrome-extension://${extId}/popup.html`, {
    scriptsDisabled: true,
  });
  const doc = await cdp("DOM.getDocument", {}, shell.session);
  const rootNode = await cdp(
    "DOM.querySelector",
    { nodeId: doc.root.nodeId, selector: "#root" },
    shell.session,
  );
  const shellBox = await cdp(
    "DOM.getBoxModel",
    { nodeId: rootNode.nodeId },
    shell.session,
  );
  check(
    "popup keeps a 380x580 shell before JavaScript loads",
    shellBox.model.width === 380 && shellBox.model.height === 580,
  );
  await cdp("Target.closeTarget", { targetId: shell.id });
  const coldPopup = await open(`chrome-extension://${extId}/popup.html`, {
    initScript: `
      window.startupCalls={refreshes:0,queries:0};
      const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=(request,...args)=>{
        if(request.type==='GET_STATE'){startupCalls.refreshes++;return new Promise(()=>{})}
        return originalSend(request,...args);
      };
      chrome.permissions.contains=async()=>false;
      chrome.tabs.query=()=>{startupCalls.queries++;return new Promise(()=>{})};
    `,
  });
  check(
    "popup opens saved controls even when the optional URL query never resolves",
    await evaluate(
      coldPopup.session,
      `
      !!document.querySelector('#daily-limit') &&
      document.querySelectorAll('#site-picker [role=option]').length===9 &&
      startupCalls.refreshes===0 && startupCalls.queries===1 &&
      !!document.querySelector('.popup-access')
    `,
    ),
  );
  await cdp("Target.closeTarget", { targetId: coldPopup.id });
  // Safari can return false for broad host access even after its website prompt was
  // accepted. Dismissing that reminder must persist without granting permissions.
  const safariPopupOptions = {
    initScript: `
      const originalURL=chrome.runtime.getURL.bind(chrome.runtime);
      chrome.runtime.getURL=(path)=>path===''?'safari-web-extension://test/':originalURL(path);
      chrome.permissions.contains=async()=>false;
    `,
  };
  const safariPopup = await open(
    `chrome-extension://${extId}/popup.html`,
    safariPopupOptions,
  );
  check(
    "Safari permission reminder explains uncertainty and can be dismissed",
    await evaluate(
      safariPopup.session,
      `
    document.querySelector('.popup-access')?.textContent.includes('Safari hasn’t confirmed') &&
    [...document.querySelectorAll('button')].some(b=>b.textContent==='Dismiss reminder')
  `,
    ),
  );
  await evaluate(
    safariPopup.session,
    `[...document.querySelectorAll('button')].find(b=>b.textContent==='Dismiss reminder').click()`,
  );
  await waitFor(
    async () =>
      await evaluate(
        safariPopup.session,
        `chrome.storage.local.get('safariSiteAccessNoticeDismissed').then(saved=>saved.safariSiteAccessNoticeDismissed===true)`,
      ),
    "saved Safari reminder dismissal",
  );
  await cdp("Target.closeTarget", { targetId: safariPopup.id });
  const reopenedSafari = await open(
    `chrome-extension://${extId}/popup.html`,
    safariPopupOptions,
  );
  check(
    "Safari reminder stays dismissed on reopening without changing host access",
    await evaluate(
      reopenedSafari.session,
      `
    (async()=>!!document.querySelector('#daily-limit') && !document.querySelector('.popup-access') &&
    await chrome.permissions.contains({origins:['<all_urls>']})===false)()
  `,
    ),
  );
  await cdp("Target.closeTarget", { targetId: reopenedSafari.id });
  const chromeAfterDismissal = await open(
    `chrome-extension://${extId}/popup.html`,
    { initScript: `chrome.permissions.contains=async()=>false;` },
  );
  check(
    "Safari dismissal does not hide Chrome's missing-access warning",
    await evaluate(
      chromeAfterDismissal.session,
      `!!document.querySelector('.popup-access')`,
    ),
  );
  await cdp("Target.closeTarget", { targetId: chromeAfterDismissal.id });
  const followsSite = await open(`chrome-extension://${extId}/popup.html`, {
    initScript: `
    chrome.permissions.contains=async()=>false;
    chrome.tabs.query=async()=>[{id:888,url:'https://www.tiktok.com/@fixture/video/123'}];
    chrome.tabs.onUpdated.addListener=fn=>window.tabChanged=fn;
    chrome.tabs.onActivated.addListener=fn=>window.tabActivated=fn;
    window.close=()=>{window.closeCalls=(window.closeCalls||0)+1};
  `,
  });
  check(
    "popup selects the current website even without broad host permission",
    await evaluate(
      followsSite.session,
      `document.querySelector('.site-summary h2').textContent==='TikTok'`,
    ),
  );
  {
    // The Mac app's "Open ScreenFry Settings" sends the browser to a placeholder address.
    const { targetId } = await cdp("Target.createTarget", {
      url: "https://open.screenfry.invalid/settings",
    });
    check(
      "the Mac app's Open ScreenFry Settings lands on the settings page",
      await waitFor(
        async () => /\/dashboard\.html(\?[^#]*)?#settings$/.test(await urlOf(targetId)),
        "settings page from the Mac app",
      ),
    );
    await cdp("Target.closeTarget", { targetId });
  }
  check(
    "popup closes when its tab navigates or another tab is selected",
    await evaluate(
      followsSite.session,
      `
    tabChanged(999,{url:'https://example.com'}); const untouched=!window.closeCalls;
    tabChanged(888,{url:'https://example.com'});tabActivated({tabId:999});
    untouched && window.closeCalls===2
  `,
    ),
  );
  await cdp("Target.closeTarget", { targetId: followsSite.id });
  const x = await send({
    type: "SAVE_RULE",
    rule: rule("youtube", "youtube.com", 0),
  });
  check(
    "limit exhaustion immediately reblocks already open tabs",
    x.ok &&
      (await waitFor(
        async () => (await urlOf(media.id)).includes("blocked.html"),
        "open tab reblock",
      )),
  );
  await evaluate(
    workerSession,
    `
    chrome.tabs.update=()=>new Promise(()=>{});
    chrome.declarativeNetRequest.updateDynamicRules=()=>new Promise(()=>{});
  `,
  );
  const editStarted = Date.now();
  const responsive = await send({
    type: "SAVE_RULE",
    rule: rule("stalled", "example.com", 0),
  });
  check(
    "settings edits finish even when browser navigation and rule compilation stall",
    responsive.ok && Date.now() - editStarted < 3000,
  );
  const readStarted = Date.now();
  const responsiveState = await getState();
  check(
    "settings remain readable during stalled enforcement",
    responsiveState.rules.some((r) => r.id === "stalled") &&
      Date.now() - readStarted < 1000,
  );
} catch (error) {
  check("script error", false, error.message);
  if (chromeErrors) console.error("Isolated Chrome diagnostics:", chromeErrors);
} finally {
  console.log(
    `\n${checks.filter(Boolean).length} passed, ${checks.filter((x) => !x).length} failed`,
  );
  chrome.kill();
  await sleep(500);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  for (const pipe of chrome.stdio) pipe?.destroy();
  rejectPending(Error("Test finished"));
  rmSync(profile, { recursive: true, force: true });
  process.exitCode = checks.every(Boolean) ? 0 : 1;
}
