"use strict";

// Google sign-in and API calls. Each "slot" is one connected Google account:
//   gmail     - the mailbox to clean
//   driveFrom - the Drive that is running out of space
//   driveTo   - the Drive with free space that receives the files
// launchWebAuthFlow (not getAuthToken) is used so each slot can be a different
// Google account, not just the one signed in to Chrome.
const Google = (() => {
  const SCOPES = {
    gmail: "https://www.googleapis.com/auth/gmail.modify email",
    driveFrom: "https://www.googleapis.com/auth/drive email",
    driveTo: "https://www.googleapis.com/auth/drive email",
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // In the background (scheduled runs) a sign-in window must never pop up on its own.
  let quiet = false;
  const setQuiet = (on) => { quiet = on; };

  async function clientId() {
    const { clientId } = await chrome.storage.local.get("clientId");
    if (!clientId) throw new Error("Add your OAuth client ID on the Setup tab first.");
    return clientId;
  }

  // Returns { token, exp }. Without interactive, only succeeds if Google can
  // re-issue a token silently for the hinted account.
  async function authorize(slot, { interactive, hint }) {
    const params = new URLSearchParams({
      client_id: await clientId(),
      response_type: "token",
      redirect_uri: chrome.identity.getRedirectURL(),
      scope: SCOPES[slot],
      prompt: interactive ? "select_account consent" : "none",
    });
    if (hint) params.set("login_hint", hint);
    const redirect = await chrome.identity.launchWebAuthFlow({
      url: "https://accounts.google.com/o/oauth2/v2/auth?" + params,
      interactive,
    });
    const result = new URLSearchParams(new URL(redirect).hash.slice(1));
    if (result.get("error")) throw new Error("Google sign-in failed: " + result.get("error"));
    return { token: result.get("access_token"), exp: Date.now() + Number(result.get("expires_in")) * 1000 };
  }

  async function emailFor(token) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error("Couldn't read the account's email address.");
    return (await res.json()).email;
  }

  // Tokens live in session storage (gone when Chrome closes); emails in local storage.
  async function saveToken(slot, t) {
    const { tokens = {} } = await chrome.storage.session.get("tokens");
    tokens[slot] = t;
    await chrome.storage.session.set({ tokens });
  }
  async function forgetToken(slot) {
    const { tokens = {} } = await chrome.storage.session.get("tokens");
    const old = tokens[slot];
    delete tokens[slot];
    await chrome.storage.session.set({ tokens });
    return old;
  }

  async function account(slot) {
    const { accounts = {} } = await chrome.storage.local.get("accounts");
    return accounts[slot] || null;
  }

  async function connect(slot) {
    const t = await authorize(slot, { interactive: true });
    const email = await emailFor(t.token);
    await saveToken(slot, t);
    const { accounts = {} } = await chrome.storage.local.get("accounts");
    accounts[slot] = email;
    await chrome.storage.local.set({ accounts });
    return email;
  }

  async function disconnect(slot) {
    const old = await forgetToken(slot);
    if (old) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(old.token), { method: "POST" }).catch(() => {});
    const { accounts = {} } = await chrome.storage.local.get("accounts");
    delete accounts[slot];
    await chrome.storage.local.set({ accounts });
  }

  async function token(slot) {
    const { tokens = {} } = await chrome.storage.session.get("tokens");
    if (tokens[slot] && tokens[slot].exp - 60000 > Date.now()) return tokens[slot].token;
    const email = await account(slot);
    if (!email) throw new Error("Connect a Google account first.");
    let t;
    try {
      t = await authorize(slot, { interactive: false, hint: email });
    } catch {
      if (quiet) {
        const e = new Error(`Google needs you to sign in to ${email} again. Open the app and reconnect it.`);
        e.signIn = true;
        throw e;
      }
      t = await authorize(slot, { interactive: true, hint: email });
    }
    // Never act on a different account than the one the user connected.
    const got = await emailFor(t.token);
    if (got.toLowerCase() !== email.toLowerCase()) throw new Error(`Signed in as ${got}, expected ${email}. Reconnect the account.`);
    await saveToken(slot, t);
    return t.token;
  }

  // fetch() with auth, JSON bodies, and retries on expired tokens and rate limits.
  async function api(slot, url, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `Bearer ${await token(slot)}`, ...opts.headers };
      if (typeof opts.body === "string") headers["Content-Type"] = "application/json";
      const res = await fetch(url, { ...opts, headers });
      if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);

      const body = await res.json().catch(() => ({}));
      const err = body.error || {};
      const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || "";
      const rateLimited = res.status === 429 || res.status >= 500 || /rateLimit|userRateLimit/i.test(reason);
      if (res.status === 401 && attempt === 0) {
        await forgetToken(slot);
        continue;
      }
      if (rateLimited && attempt < 5) {
        await sleep(2 ** attempt * 1000 + Math.random() * 500);
        continue;
      }
      const e = new Error(err.message || `Google returned ${res.status}`);
      e.status = res.status;
      throw e;
    }
  }

  // Runs fn over items with at most `limit` calls in flight.
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  return { account, connect, disconnect, api, pool, setQuiet };
})();
