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

  // Picks how to unsubscribe from a List-Unsubscribe header such as
  // `<mailto:leave@list.com?subject=unsubscribe>, <https://list.com/u?id=1>`.
  // Best first: one-click POST (RFC 8058), then an unsubscribe email, then a web page to open.
  function unsubscribeMethod(header, postHeader) {
    const urls = [...String(header || "").matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
    const https = urls.find((u) => /^https:\/\//i.test(u));
    if (https && /List-Unsubscribe=One-Click/i.test(postHeader || "")) return { type: "post", url: https };
    const mailto = urls.find((u) => /^mailto:/i.test(u));
    if (mailto) {
      try {
        const u = new URL(mailto);
        const to = decodeURIComponent(u.pathname).split(",")[0].trim();
        const clean = (s) => String(s || "").replace(/[\r\n]+/g, " ").trim();
        if (/^[^\s@<>]+@[^\s@<>]+$/.test(to)) {
          return { type: "mailto", to, subject: clean(u.searchParams.get("subject")) || "unsubscribe", body: u.searchParams.get("body") || "unsubscribe" };
        }
      } catch {}
    }
    const link = https || urls.find((u) => /^http:\/\//i.test(u));
    return link ? { type: "link", url: link } : null;
  }

  // Count senders by address (or by domain, so all of facebookmail.com is one row).
  // `unsub` keeps the newest unsubscribe method per address (scan results are newest first).
  function groupSenders(list, byDomain) {
    const groups = new Map();
    for (const s of list) {
      const key = byDomain ? s.domain : s.address;
      const g = groups.get(key) || { key, name: byDomain ? s.domain : s.name, count: 0, newsletter: false, addresses: [], unsub: {} };
      g.count++;
      g.newsletter = g.newsletter || s.newsletter;
      if (!g.addresses.includes(s.address)) g.addresses.push(s.address);
      if (s.unsub && !g.unsub[s.address]) g.unsub[s.address] = s.unsub;
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
      const h = await headers(id, ["From", "List-Unsubscribe", "List-Unsubscribe-Post"]);
      if (onProgress) onProgress(++done, ids.length);
      return {
        ...parseFrom(h.from),
        newsletter: !!h["list-unsubscribe"],
        unsub: unsubscribeMethod(h["list-unsubscribe"], h["list-unsubscribe-post"]),
      };
    });
  }

  // Sends a plain-text email from the connected account (used for mailto: unsubscribes).
  async function send(to, subject, body) {
    const raw = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n`;
    const bytes = new TextEncoder().encode(raw);
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await Google.api("gmail", `${BASE}/messages/send`, { method: "POST", body: JSON.stringify({ raw: b64 }) });
  }

  // Returns "done" (request or email sent) or "opened" (page opened for the user to finish).
  async function unsubscribe(method) {
    if (method.type === "post") {
      // no-cors: the sender's server gets the standard one-click request without
      // the extension needing access to every website. The reply can't be read,
      // but network failures still throw.
      await fetch(method.url, {
        method: "POST",
        mode: "no-cors",
        credentials: "omit",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
      return "done";
    }
    if (method.type === "mailto") {
      await send(method.to, method.subject, method.body);
      return "done";
    }
    await chrome.tabs.create({ url: method.url, active: false });
    return "opened";
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

  return { buildQuery, parseFrom, unsubscribeMethod, groupSenders, matchIds, scanSenders, samples, trash, unsubscribe };
})();

if (typeof module !== "undefined") module.exports = Gmail;
