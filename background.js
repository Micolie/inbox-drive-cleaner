importScripts("lib/google.js", "lib/gmail.js");
Google.setQuiet(true);

const ALARM = "scheduled-cleanup";
const DAY_MINUTES = 24 * 60;
const SCHEDULE_DEFAULTS = { enabled: false, every: "daily", hour: 9, maxPerRun: 1000, notify: true };

// The toolbar button (and clicking a notification) opens the app in a tab, or focuses it if it's already open.
function openApp() {
  const url = chrome.runtime.getURL("app.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}
chrome.action.onClicked.addListener(openApp);
chrome.notifications.onClicked.addListener((id) => {
  chrome.notifications.clear(id);
  openApp();
});

async function getSchedule() {
  const { schedule } = await chrome.storage.local.get("schedule");
  return { ...SCHEDULE_DEFAULTS, ...schedule };
}

// Next time the clock shows `hour`:00 (today if still ahead, else tomorrow).
function nextRun(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// `reset` re-creates the alarm after the settings change. Without it an existing
// alarm is kept, so a run missed while Chrome was closed still fires on startup.
async function syncAlarm(reset) {
  const s = await getSchedule();
  const existing = await chrome.alarms.get(ALARM);
  if (!s.enabled) return chrome.alarms.clear(ALARM);
  if (existing && !reset) return;
  await chrome.alarms.create(ALARM, {
    when: nextRun(s.hour),
    periodInMinutes: s.every === "weekly" ? 7 * DAY_MINUTES : DAY_MINUTES,
  });
}
chrome.runtime.onInstalled.addListener(() => syncAlarm(false));
chrome.runtime.onStartup.addListener(() => syncAlarm(false));

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Inbox & Drive Cleaner",
    message,
  });
}

// Runs every switched-on rule and trashes the matches, unless more match than
// the per-run limit (then nothing is touched and the user is asked to review).
async function runCleanup() {
  const { rules = [] } = await chrome.storage.local.get("rules");
  const s = await getSchedule();
  const limit = Math.max(1, Number(s.maxPerRun) || SCHEDULE_DEFAULTS.maxPerRun);
  let result;
  try {
    const active = rules.filter((r) => r.enabled && Gmail.buildQuery(r));
    if (!active.length) throw new Error("No rules are switched on, so nothing was cleaned.");
    const all = new Set();
    for (const r of active) {
      for (const id of await Gmail.matchIds(Gmail.buildQuery(r), limit + 1)) all.add(id);
      if (all.size > limit) break;
    }
    if (all.size > limit) {
      result = { ok: false, count: 0, message: `More than ${limit} emails matched your rules, which is over your limit per run, so nothing was trashed. Open the app to review and run it by hand.` };
    } else {
      if (all.size) await Gmail.trash([...all]);
      result = { ok: true, count: all.size, message: all.size ? `Moved ${all.size} emails to Trash.` : "Nothing new to clean." };
    }
  } catch (e) {
    result = { ok: false, count: 0, message: e.message };
  }

  // Re-read so settings changed while this ran aren't overwritten.
  const { schedule = {} } = await chrome.storage.local.get("schedule");
  await chrome.storage.local.set({ schedule: { ...schedule, lastRun: Date.now(), lastResult: result } });
  if (!result.ok || (result.count && s.notify)) notify(result.message);
  return result;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) runCleanup();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "schedule-changed") {
    syncAlarm(true).then(() => chrome.alarms.get(ALARM)).then((a) => sendResponse({ next: a ? a.scheduledTime : null }));
    return true;
  }
  if (msg.type === "run-cleanup-now") {
    runCleanup().then(sendResponse);
    return true;
  }
  if (msg.type === "next-run") {
    chrome.alarms.get(ALARM).then((a) => sendResponse({ next: a ? a.scheduledTime : null }));
    return true;
  }
});
