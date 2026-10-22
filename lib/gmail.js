"use strict";

// Gmail: turn the user's rules into Gmail search queries, find matching
// messages, and move them to Trash (Gmail empties Trash after 30 days).
const Gmail = (() => {
  const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

  const splitList = (s) => String(s || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  const term = (s) => (/[\s()"{}]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
  const anyOf = (items) => (items.length === 1 ? term(items[0]) : `(${items.map(term).join(" OR ")})`);

  // A rule needs at least one condition, so an empty rule can never match the whole mailbox.
  function buildQuery(rule) {
    const parts = [];
    const from = splitList(rule.from);
    const subject = splitList(rule.subject);
    if (from.length) parts.push("from:" + anyOf(from));
    if (subject.length) parts.push("subject:" + anyOf(subject));
    if (rule.category) parts.push("category:" + rule.category);
    if (rule.olderThanDays > 0) parts.push(`older_than:${Math.floor(rule.olderThanDays)}d`);
    if (rule.largerThanMb > 0) parts.push(`larger:${Math.round(rule.largerThanMb * 1024)}K`);
    if (!parts.length) return "";
    if (rule.keepStarred) parts.push("-is:starred");
    if (rule.keepImportant) parts.push("-is:important");
    return parts.join(" ");
  }

  // `"Meta" <notification@facebookmail.com>` -> { name, address, domain }
  function parseFrom(header) {
    const h = String(header || "").trim();
    const m = h.match(/^(.*?)\s*<([^>]+)>\s*$/);
    const address = (m ? m[2] : h).trim().toLowerCase();
    const name = (m ? m[1] : "").replace(/^"|"$/g, "").trim();
    return { name: name || address, address, domain: address.split("@")[1] || address };
  }

  // Count senders by address (or by domain, so all of facebookmail.com is one row).
  function groupSenders(list, byDomain) {
    const groups = new Map();
    for (const s of list) {
      const key = byDomain ? s.domain : s.address;
      const g = groups.get(key) || { key, name: byDomain ? s.domain : s.name, count: 0, newsletter: false };
      g.count++;
      g.newsletter = g.newsletter || s.newsletter;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }

  async function matchIds(q, max = Infinity, onProgress) {
    const ids = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({ q, maxResults: "500", fields: "messages(id),nextPageToken" });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await Google.api("gmail", `${BASE}/messages?${params}`);
      for (const m of page.messages || []) ids.push(m.id);
      pageToken = page.nextPageToken;
      if (onProgress) onProgress(ids.length);
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  async function headers(id, names) {
    const params = new URLSearchParams({ format: "metadata", fields: "payload/headers" });
    for (const n of names) params.append("metadataHeaders", n);
    const msg = await Google.api("gmail", `${BASE}/messages/${id}?${params}`);
    const out = {};
    for (const h of (msg.payload && msg.payload.headers) || []) out[h.name.toLowerCase()] = h.value;
    return out;
  }

  // Reads the sender of the newest `max` messages matching q.
  async function scanSenders(q, max, onProgress) {
    const ids = await matchIds(q, max);
    let done = 0;
    return Google.pool(ids, 10, async (id) => {
      const h = await headers(id, ["From", "List-Unsubscribe"]);
      if (onProgress) onProgress(++done, ids.length);
      return { ...parseFrom(h.from), newsletter: !!h["list-unsubscribe"] };
    });
  }

  async function samples(ids) {
    return Google.pool(ids, 5, async (id) => {
      const h = await headers(id, ["From", "Subject", "Date"]);
      return { from: parseFrom(h.from).name, subject: h.subject || "(no subject)", date: h.date || "" };
    });
  }

  async function trash(ids, onProgress) {
    let done = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      try {
        await Google.api("gmail", `${BASE}/messages/batchModify`, {
          method: "POST",
          body: JSON.stringify({ ids: chunk, addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] }),
        });
        done += chunk.length;
        if (onProgress) onProgress(done, ids.length);
      } catch (e) {
        if (e.status !== 400) throw e;
        // Fallback if batch labelling with TRASH is refused: trash one by one.
        await Google.pool(chunk, 10, async (id) => {
          await Google.api("gmail", `${BASE}/messages/${id}/trash`, { method: "POST" });
          if (onProgress) onProgress(++done, ids.length);
        });
      }
    }
  }

  return { buildQuery, parseFrom, groupSenders, matchIds, scanSenders, samples, trash };
})();

if (typeof module !== "undefined") module.exports = Gmail;
