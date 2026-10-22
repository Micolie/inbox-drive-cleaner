"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const store = chrome.storage.local;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtBytes(n) {
  if (n === Infinity) return "unlimited";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${units[i]}`;
}

function status(sel, msg, kind = "") {
  const el = $(sel);
  el.textContent = msg;
  el.className = "status " + kind;
}

// Runs an async click handler with the button disabled, reporting errors to a status line.
function action(btn, statusSel, fn) {
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      status(statusSel, e.message, "bad");
    } finally {
      btn.disabled = false;
    }
  });
}

// ------------------------------------------------------------------ tabs

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach((p) => p.classList.toggle("hidden", p.dataset.tab !== name));
  store.set({ tab: name });
}
$$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

// ------------------------------------------------------------------ accounts

async function renderAccount(slot) {
  const email = await Google.account(slot);
  const box = $(`[data-account="${slot}"]`);
  box.innerHTML = email
    ? `<span>✓ <b>${esc(email)}</b></span><button class="link" data-act="disconnect">Disconnect</button>`
    : `<button class="primary" data-act="connect">Connect Google account</button>`;
  if (slot !== "gmail") renderQuota(slot, email);
}

async function renderQuota(slot, email) {
  const box = $(`[data-quota="${slot}"]`);
  if (!email) { box.textContent = ""; return; }
  try {
    const q = await Drive.about(slot);
    const pct = q.limit ? Math.min(100, (q.usage / q.limit) * 100) : 0;
    box.innerHTML = `${fmtBytes(q.usage)} of ${fmtBytes(q.limit ?? Infinity)} used · <b>${fmtBytes(q.free)} free</b>
      <div class="meter"><div style="width:${pct.toFixed(1)}%"></div></div>
      Drive files ${fmtBytes(q.drive)} · Drive Trash ${fmtBytes(q.trash)} · Gmail &amp; Photos ${fmtBytes(q.other)}`;
    quota[slot] = q;
    renderFileSummary();
  } catch (e) {
    box.textContent = e.message;
  }
}

const quota = {};

$$(".account").forEach((box) => {
  box.addEventListener("click", async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const slot = box.dataset.account;
    e.target.disabled = true;
    try {
      if (act === "connect") await Google.connect(slot);
      else await Google.disconnect(slot);
    } catch (err) {
      alert(err.message);
    }
    renderAccount(slot);
  });
});

// ------------------------------------------------------------------ setup

$("#redirectUrl").value = chrome.identity.getRedirectURL();
$("#copyRedirect").addEventListener("click", () => {
  navigator.clipboard.writeText($("#redirectUrl").value);
  status("#setupStatus", "Redirect URI copied.", "good");
});
$("#saveClientId").addEventListener("click", async () => {
  const clientId = $("#clientId").value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) {
    status("#setupStatus", "That doesn't look like a client ID (it ends in .apps.googleusercontent.com).", "bad");
    return;
  }
  await store.set({ clientId });
  status("#setupStatus", "Saved. Now connect your accounts on the other tabs.", "good");
});
$("#resetAll").addEventListener("click", async () => {
  if (!confirm("Disconnect every account and delete your rules and settings?")) return;
  for (const slot of ["gmail", "driveFrom", "driveTo"]) await Google.disconnect(slot).catch(() => {});
  await store.clear();
  await chrome.storage.session.clear();
  await chrome.runtime.sendMessage({ type: "schedule-changed" });
  location.reload();
});

// ------------------------------------------------------------------ Gmail: senders

let senders = [];

action($("#scanSenders"), "#senderStatus", async () => {
  status("#senderStatus", "Listing emails…");
  senders = await Gmail.scanSenders($("#senderScope").value, Number($("#senderMax").value) || 500,
    (done, total) => status("#senderStatus", `Reading senders… ${done}/${total}`));
  status("#senderStatus", `Read ${senders.length} emails.`, "good");
  renderSenders();
});

let senderGroups = [];
// address -> { date, how } for lists already unsubscribed from (kept across scans)
let unsubscribed = {};
const UNSUB_LABEL = { post: "1-click", mailto: "email", link: "web page" };

function unsubCell(g) {
  const methods = Object.entries(g.unsub);
  if (!methods.length) return "";
  const pending = methods.filter(([a]) => !unsubscribed[a]);
  if (!pending.length) {
    const u = unsubscribed[methods[0][0]];
    return `<span class="pill">✓ ${u.how === "link" ? "page opened" : "unsubscribed"} ${esc(u.date)}</span>`;
  }
  const kinds = [...new Set(pending.map(([, m]) => UNSUB_LABEL[m.type]))];
  return `<span class="hint">${kinds.join(", ")}</span>`;
}

function renderSenders() {
  $("#senderBox").classList.toggle("hidden", !senders.length);
  senderGroups = Gmail.groupSenders(senders, $("#groupDomain").checked);
  if ($("#onlyNewsletters").checked) senderGroups = senderGroups.filter((g) => g.newsletter);
  $("#senderAll").checked = false;
  $("#senderRows").innerHTML = senderGroups.map((g, i) => `
    <tr>
      <td><input type="checkbox" data-i="${i}"></td>
      <td>${esc(g.name)}${g.name !== g.key ? ` <span class="hint">${esc(g.key)}</span>` : ""}</td>
      <td class="num">${g.count}</td>
      <td>${unsubCell(g)}</td>
    </tr>`).join("");
}
$("#groupDomain").addEventListener("change", renderSenders);
$("#onlyNewsletters").addEventListener("change", renderSenders);
$("#senderAll").addEventListener("change", (e) => $$("#senderRows input").forEach((c) => (c.checked = e.target.checked)));

const pickedSenders = () => $$("#senderRows input:checked").map((c) => senderGroups[c.dataset.i]);

function addSenderRule(groups, prefix = "") {
  const keys = groups.map((g) => g.key);
  const name = prefix + (keys.length === 1 ? keys[0] : `${keys[0]} + ${keys.length - 1} more`);
  addRule({ name, from: keys.join(", ") });
  $("#rules").lastElementChild.scrollIntoView({ behavior: "smooth", block: "center" });
}

$("#addSenderRule").addEventListener("click", () => {
  const picked = pickedSenders();
  if (!picked.length) return alert("Tick at least one sender first.");
  addSenderRule(picked);
});

action($("#unsubSelected"), "#senderStatus", async () => {
  const picked = pickedSenders();
  if (!picked.length) throw new Error("Tick at least one sender first.");
  const jobs = picked.flatMap((g) => Object.entries(g.unsub).filter(([a]) => !unsubscribed[a]).map(([address, method]) => ({ address, method })));
  if (!jobs.length) throw new Error("None of the selected senders offer an unsubscribe option you haven't used already.");
  const pages = jobs.filter((j) => j.method.type === "link").length;
  let msg = `Unsubscribe from ${jobs.length} mailing list${jobs.length > 1 ? "s" : ""}?`;
  if (pages) msg += `\n\n${pages} only offer a web page. Those open in background tabs for you to finish.`;
  if (!confirm(msg)) return;

  const date = new Date().toISOString().slice(0, 10);
  const failed = [];
  let done = 0;
  for (const j of jobs) {
    status("#senderStatus", `Unsubscribing… ${done + failed.length + 1}/${jobs.length}`);
    try {
      await Gmail.unsubscribe(j.method);
      unsubscribed[j.address] = { date, how: j.method.type };
      done++;
    } catch (e) {
      failed.push(`${j.address} (${e.message})`);
    }
  }
  await store.set({ unsubscribed });
  if ($("#unsubRule").checked) addSenderRule(picked, "Unsubscribed: ");
  renderSenders();
  const opened = jobs.filter((j) => j.method.type === "link" && unsubscribed[j.address]).length;
  let summary = `Unsubscribed from ${done - opened}`;
  if (opened) summary += `, opened ${opened} page${opened > 1 ? "s" : ""} to finish`;
  if (failed.length) summary += `. Failed: ${failed.join("; ")}`;
  status("#senderStatus", summary + ". Senders can take a few days to stop.", failed.length ? "bad" : "good");
});

// ------------------------------------------------------------------ Gmail: rules

const NEW_RULE = { enabled: true, name: "", from: "", subject: "", category: "", olderThanDays: 0, largerThanMb: 0, keepStarred: true, keepImportant: false };
const CATEGORIES = [["", "Any"], ["promotions", "Promotions"], ["social", "Social"], ["updates", "Updates"], ["forums", "Forums"]];
let rules = [];

const saveRules = () => store.set({ rules });

function addRule(fields) {
  rules.push({ ...NEW_RULE, ...fields });
  saveRules();
  renderRules();
}

function queryText(r) {
  return Gmail.buildQuery(r) || "Add at least one condition (sender, subject, category, age or size).";
}

function renderRules() {
  if (!rules.length) {
    $("#rules").innerHTML = `<p class="hint">No rules yet. Pick senders above, or click <b>+ New rule</b>.</p>`;
    return;
  }
  $("#rules").innerHTML = rules.map((r, i) => `
    <div class="rule ${r.enabled ? "" : "off"}" data-i="${i}">
      <div class="row">
        <label class="check"><input type="checkbox" data-f="enabled" ${r.enabled ? "checked" : ""}> On</label>
        <input type="text" data-f="name" value="${esc(r.name)}" placeholder="Rule name, e.g. Meta marketing">
        <button class="link" data-act="remove">Remove</button>
      </div>
      <div class="grid">
        <label>From <span class="hint">senders or domains, comma-separated</span>
          <input type="text" data-f="from" value="${esc(r.from)}" placeholder="facebookmail.com, news@meta.com"></label>
        <label>Subject contains <span class="hint">comma-separated</span>
          <input type="text" data-f="subject" value="${esc(r.subject)}" placeholder="sale, % off"></label>
        <label>Gmail category
          <select data-f="category">${CATEGORIES.map(([v, l]) => `<option value="${v}" ${r.category === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Older than (days) <span class="hint">0 = any age</span>
          <input type="number" data-f="olderThanDays" min="0" value="${r.olderThanDays}"></label>
        <label>Larger than (MB) <span class="hint">0 = any size</span>
          <input type="number" data-f="largerThanMb" min="0" step="0.5" value="${r.largerThanMb}"></label>
        <div>
          <label class="check"><input type="checkbox" data-f="keepStarred" ${r.keepStarred ? "checked" : ""}> Keep starred</label><br>
          <label class="check"><input type="checkbox" data-f="keepImportant" ${r.keepImportant ? "checked" : ""}> Keep important</label>
        </div>
      </div>
      <code class="query">${esc(queryText(r))}</code>
    </div>`).join("");
}

$("#rules").addEventListener("input", (e) => {
  const f = e.target.dataset.f;
  if (!f) return;
  const el = e.target.closest(".rule");
  const r = rules[el.dataset.i];
  const t = e.target;
  r[f] = t.type === "checkbox" ? t.checked : t.type === "number" ? Math.max(0, Number(t.value) || 0) : t.value;
  el.classList.toggle("off", !r.enabled);
  el.querySelector(".query").textContent = queryText(r);
  saveRules();
});
$("#rules").addEventListener("click", (e) => {
  if (e.target.dataset.act !== "remove") return;
  const i = Number(e.target.closest(".rule").dataset.i);
  if (!confirm(`Remove the rule "${rules[i].name || "untitled"}"?`)) return;
  rules.splice(i, 1);
  saveRules();
  renderRules();
});
$("#addRule").addEventListener("click", () => addRule({ name: "New rule" }));

// ------------------------------------------------------------------ Gmail: run

let matched = [];

action($("#runRules"), "#runStatus", async () => {
  const active = rules.filter((r) => r.enabled && Gmail.buildQuery(r));
  if (!active.length) throw new Error("Switch on at least one rule with a condition.");
  matched = [];
  $("#trashMatched").disabled = true;
  $("#runResults").innerHTML = "";
  const all = new Set();
  const rows = [];
  for (const r of active) {
    const label = r.name || "untitled";
    const ids = await Gmail.matchIds(Gmail.buildQuery(r), Infinity, (n) => status("#runStatus", `${label}: ${n} found…`));
    ids.forEach((id) => all.add(id));
    rows.push({ label, count: ids.length, samples: await Gmail.samples(ids.slice(0, 3)) });
  }
  matched = [...all];
  $("#runResults").innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr><th>Rule</th><th class="num">Emails</th></tr></thead>
      <tbody>${rows.map((x) => `
        <tr><td><b>${esc(x.label)}</b>
          ${x.samples.length ? `<ul class="samples">${x.samples.map((s) => `<li>${esc(s.from)}: ${esc(s.subject)}</li>`).join("")}</ul>` : ""}
        </td><td class="num">${x.count}</td></tr>`).join("")}
      </tbody>
    </table></div>`;
  status("#runStatus", `${matched.length} emails match (counted once even if several rules match).`, matched.length ? "good" : "");
  $("#trashMatched").textContent = `Move ${matched.length} to Trash`;
  // The finally block in action() re-enables only the run button.
  setTimeout(() => ($("#trashMatched").disabled = !matched.length));
});

action($("#trashMatched"), "#runStatus", async () => {
  if (!matched.length) return;
  if (!confirm(`Move ${matched.length} emails to Trash?\n\nYou can restore them from Gmail's Trash for 30 days; after that Gmail deletes them for good.`)) return;
  await Gmail.trash(matched, (done, total) => status("#runStatus", `Moving to Trash… ${done}/${total}`));
  status("#runStatus", `Moved ${matched.length} emails to Trash.`, "good");
  matched = [];
  $("#trashMatched").textContent = "Move to Trash";
  setTimeout(() => ($("#trashMatched").disabled = true));
});

// ------------------------------------------------------------------ Gmail: automatic cleanup

const SCHED_FIELDS = { enabled: "#schedEnabled", every: "#schedEvery", hour: "#schedHour", maxPerRun: "#schedMax", notify: "#schedNotify" };

$("#schedHour").innerHTML = Array.from({ length: 24 }, (_, h) =>
  `<option value="${h}">${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</option>`).join("");

const fmtTime = (ms) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

async function renderSchedule(nextRun) {
  const { schedule = {} } = await store.get("schedule");
  const parts = [];
  if (schedule.enabled && nextRun) parts.push(`Next run: ${fmtTime(nextRun)}.`);
  if (schedule.lastRun) parts.push(`Last run ${fmtTime(schedule.lastRun)}: ${schedule.lastResult.message}`);
  status("#schedStatus", parts.join(" ") || "Off.", schedule.lastResult && !schedule.lastResult.ok ? "bad" : "");
}

async function loadSchedule() {
  const { schedule = {} } = await store.get("schedule");
  for (const [k, sel] of Object.entries(SCHED_FIELDS)) {
    if (schedule[k] === undefined) continue;
    const el = $(sel);
    if (el.type === "checkbox") el.checked = schedule[k]; else el.value = schedule[k];
  }
  if (schedule.hour === undefined) $("#schedHour").value = "9";
  const { next } = await chrome.runtime.sendMessage({ type: "next-run" });
  renderSchedule(next);
}

async function saveSchedule() {
  const { schedule = {} } = await store.get("schedule");
  const s = { ...schedule };
  for (const [k, sel] of Object.entries(SCHED_FIELDS)) {
    const el = $(sel);
    s[k] = el.type === "checkbox" ? el.checked : el.type === "number" || k === "hour" ? Math.max(0, Number(el.value) || 0) : el.value;
  }
  const noRules = s.enabled && !rules.some((r) => r.enabled && Gmail.buildQuery(r));
  if (noRules) $("#schedEnabled").checked = s.enabled = false;
  await store.set({ schedule: s });
  const { next } = await chrome.runtime.sendMessage({ type: "schedule-changed" });
  await renderSchedule(next);
  if (noRules) status("#schedStatus", "Add and switch on at least one rule first.", "bad");
}
Object.values(SCHED_FIELDS).forEach((sel) => $(sel).addEventListener("change", saveSchedule));

action($("#schedRunNow"), "#schedStatus", async () => {
  status("#schedStatus", "Running your rules…");
  await chrome.runtime.sendMessage({ type: "run-cleanup-now" });
  const { next } = await chrome.runtime.sendMessage({ type: "next-run" });
  await renderSchedule(next);
});

// ------------------------------------------------------------------ Drive

let files = [];
let stopRequested = false;

action($("#findFiles"), "#fileStatus", async () => {
  status("#fileStatus", "Looking…");
  const minBytes = Math.max(0, Number($("#minMb").value) || 0) * 1024 * 1024;
  const found = await Drive.largeFiles("driveFrom", minBytes, 500, (scanned, n) => status("#fileStatus", `Checked ${scanned} files, ${n} big enough…`));
  files = found.files;
  renderFiles();
  if (files.length) return status("#fileStatus", `Checked ${found.scanned} files: ${files.length} are big enough, biggest first.`, "good");
  // Say why nothing was found, using the storage breakdown when it's loaded.
  const email = await Google.account("driveFrom");
  const q = quota.driveFrom;
  let msg = found.scanned
    ? `Checked all ${found.scanned} files owned by ${email}. None are over ${fmtBytes(minBytes)}; the biggest is "${found.biggest.name}" (${fmtBytes(found.biggest.bytes)}). Try a smaller size.`
    : `${email} doesn't own any Drive files. Files shared with you or in shared drives don't use your storage.`;
  if (q) msg += ` This account's storage: Drive files ${fmtBytes(q.drive)}, Drive Trash ${fmtBytes(q.trash)}, Gmail & Photos ${fmtBytes(q.other)}.`;
  status("#fileStatus", msg, "bad");
});

function renderFiles() {
  $("#fileBox").classList.toggle("hidden", !files.length);
  $("#fileAll").checked = false;
  $("#fileRows").innerHTML = files.map((f, i) => `
    <tr>
      <td><input type="checkbox" data-i="${i}"></td>
      <td><a href="${esc(f.webViewLink)}" target="_blank" rel="noopener">${esc(f.name)}</a></td>
      <td class="hint">${esc(f.mimeType.split("/").pop().replace("vnd.google-apps.", "Google "))}</td>
      <td class="num">${fmtBytes(f.bytes)}</td>
      <td class="hint">${esc((f.modifiedTime || "").slice(0, 10))}</td>
    </tr>`).join("");
  renderFileSummary();
}

const selectedFiles = () => $$("#fileRows input:checked").map((c) => files[c.dataset.i]);

function renderFileSummary() {
  if (!files.length) return;
  const sel = selectedFiles();
  const total = sel.reduce((n, f) => n + f.bytes, 0);
  let msg = `${sel.length} selected · ${fmtBytes(total)}`;
  const to = quota.driveTo;
  if (to) msg += to.free < total ? ` · ⚠ "To" only has ${fmtBytes(to.free)} free` : ` · "To" has ${fmtBytes(to.free)} free`;
  $("#fileSummary").textContent = msg;
  $("#transfer").disabled = !sel.length;
}
$("#fileRows").addEventListener("change", renderFileSummary);
$("#fileAll").addEventListener("change", (e) => {
  $$("#fileRows input").forEach((c) => (c.checked = e.target.checked));
  renderFileSummary();
});

function log(msg, kind) {
  const li = document.createElement("li");
  li.textContent = msg;
  if (kind) li.className = kind;
  $("#transferLog").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

$("#transfer").addEventListener("click", async () => {
  const sel = selectedFiles();
  const fromEmail = await Google.account("driveFrom");
  const toEmail = await Google.account("driveTo");
  if (!fromEmail || !toEmail) return alert("Connect both the From and To accounts first.");
  if (fromEmail.toLowerCase() === toEmail.toLowerCase()) return alert("From and To are the same account.");
  const after = $("#afterCopy").value;
  const afterText = { trash: "move the originals to Trash", delete: "permanently delete the originals", keep: "keep the originals" }[after];
  if (!confirm(`Copy ${sel.length} files to ${toEmail}, then ${afterText} in ${fromEmail}?`)) return;

  stopRequested = false;
  $("#transfer").disabled = true;
  $("#stopTransfer").classList.remove("hidden");
  $("#transferLog").innerHTML = "";
  const moved = new Set();
  try {
    const folderId = await Drive.ensureFolder("driveTo", `Moved from ${fromEmail}`);
    for (const f of sel) {
      if (stopRequested) { log("Stopped."); break; }
      try {
        await Drive.transfer(f, { toEmail, folderId, after });
        moved.add(f);
        log(`✓ ${f.name} (${fmtBytes(f.bytes)})`, "ok");
      } catch (e) {
        log(`✗ ${f.name}: ${e.message}`, "fail");
      }
    }
  } catch (e) {
    log(e.message, "fail");
  }
  if (after !== "keep") files = files.filter((f) => !moved.has(f));
  $("#stopTransfer").classList.add("hidden");
  log(`Done: ${moved.size} of ${sel.length} moved to the "Moved from ${fromEmail}" folder in ${toEmail}.`);
  renderFiles();
  renderQuota("driveFrom", fromEmail);
  renderQuota("driveTo", toEmail);
});
$("#stopTransfer").addEventListener("click", () => { stopRequested = true; });

action($("#emptyTrash"), "#fileStatus", async () => {
  const email = await Google.account("driveFrom");
  if (!email) throw new Error("Connect the From account first.");
  if (!confirm(`Permanently delete everything in the Drive Trash of ${email}? This can't be undone.`)) return;
  await Drive.emptyTrash("driveFrom");
  status("#fileStatus", "Trash emptied.", "good");
  renderQuota("driveFrom", email);
});

// ------------------------------------------------------------------ start

(async () => {
  const data = await store.get(["clientId", "rules", "tab", "unsubscribed"]);
  $("#clientId").value = data.clientId || "";
  rules = data.rules || [];
  unsubscribed = data.unsubscribed || {};
  renderRules();
  loadSchedule();
  ["gmail", "driveFrom", "driveTo"].forEach(renderAccount);
  showTab(data.clientId ? data.tab || "gmail" : "setup");
})();
