"use strict";

// Drive: move large files from one Google account to another.
// The copy is made server-side by Google (nothing is downloaded): the source
// account shares the file with the destination account, the destination makes
// its own copy (which then counts against the destination's storage), the copy
// is checked against the original, and only then is the original removed.
const Drive = (() => {
  const BASE = "https://www.googleapis.com/drive/v3";
  const FOLDER = "application/vnd.google-apps.folder";
  const quoteQ = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  async function about(slot) {
    const a = await Google.api(slot, `${BASE}/about?fields=user(emailAddress),storageQuota`);
    const q = a.storageQuota || {};
    const limit = q.limit ? Number(q.limit) : null; // null = unlimited
    const usage = Number(q.usage || 0);
    const drive = Number(q.usageInDrive || 0);
    const trash = Number(q.usageInDriveTrash || 0);
    return {
      email: a.user.emailAddress,
      usage,
      limit,
      free: limit === null ? Infinity : Math.max(0, limit - usage),
      drive: drive - trash, // usageInDrive includes the Drive trash
      trash,
      other: Math.max(0, usage - drive), // Gmail and Google Photos
    };
  }

  // Files owned by the account that are at least minBytes, biggest first.
  // Every file is checked: Drive's "orderBy=quotaBytesUsed" isn't reliably
  // sorted, so stopping at the first small file would miss big ones.
  async function largeFiles(slot, minBytes, max, onProgress) {
    const files = [];
    let scanned = 0;
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'me' in owners and trashed = false and mimeType != '${FOLDER}'`,
        pageSize: "1000",
        fields: "nextPageToken,files(id,name,mimeType,size,quotaBytesUsed,md5Checksum,modifiedTime,webViewLink)",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await Google.api(slot, `${BASE}/files?${params}`);
      for (const f of page.files || []) {
        f.bytes = Math.max(Number(f.quotaBytesUsed || 0), Number(f.size || 0));
        if (f.bytes >= minBytes) files.push(f);
      }
      scanned += (page.files || []).length;
      pageToken = page.nextPageToken;
      if (onProgress) onProgress(scanned, files.length);
    } while (pageToken);
    return files.sort((a, b) => b.bytes - a.bytes).slice(0, max);
  }

  async function ensureFolder(slot, name) {
    const q = `name = '${quoteQ(name)}' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`;
    const found = await Google.api(slot, `${BASE}/files?${new URLSearchParams({ q, fields: "files(id)" })}`);
    if (found.files && found.files.length) return found.files[0].id;
    const made = await Google.api(slot, `${BASE}/files?fields=id`, {
      method: "POST",
      body: JSON.stringify({ name, mimeType: FOLDER, parents: ["root"] }),
    });
    return made.id;
  }

  // after: "keep" | "trash" | "delete"
  async function transfer(file, { toEmail, folderId, after }) {
    const perm = await Google.api("driveFrom", `${BASE}/files/${file.id}/permissions?sendNotificationEmail=false&fields=id`, {
      method: "POST",
      body: JSON.stringify({ role: "reader", type: "user", emailAddress: toEmail }),
    });
    const copy = await Google.api("driveTo", `${BASE}/files/${file.id}/copy?fields=id,size,md5Checksum`, {
      method: "POST",
      body: JSON.stringify({ name: file.name, parents: [folderId] }),
    });
    const mismatch =
      (file.md5Checksum && copy.md5Checksum !== file.md5Checksum) ||
      (file.size && copy.size && copy.size !== file.size);
    if (mismatch) {
      await Google.api("driveTo", `${BASE}/files/${copy.id}`, { method: "DELETE" }).catch(() => {});
      throw new Error("The copy didn't match the original, so the original was kept.");
    }
    if (after === "delete") {
      await Google.api("driveFrom", `${BASE}/files/${file.id}`, { method: "DELETE" });
    } else {
      await Google.api("driveFrom", `${BASE}/files/${file.id}/permissions/${perm.id}`, { method: "DELETE" }).catch(() => {});
      if (after === "trash") {
        await Google.api("driveFrom", `${BASE}/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ trashed: true }) });
      }
    }
    return copy;
  }

  async function emptyTrash(slot) {
    await Google.api(slot, `${BASE}/files/trash`, { method: "DELETE" });
  }

  return { about, largeFiles, ensureFolder, transfer, emptyTrash };
})();
