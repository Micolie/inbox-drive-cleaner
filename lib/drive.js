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
    return { email: a.user.emailAddress, usage, limit, free: limit === null ? Infinity : Math.max(0, limit - usage) };
  }

  // Files owned by the account, biggest first, down to minBytes.
  async function largeFiles(slot, minBytes, max, onProgress) {
    const files = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'me' in owners and trashed = false and mimeType != '${FOLDER}'`,
        orderBy: "quotaBytesUsed desc",
        pageSize: "100",
        fields: "nextPageToken,files(id,name,mimeType,size,quotaBytesUsed,md5Checksum,modifiedTime,webViewLink)",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await Google.api(slot, `${BASE}/files?${params}`);
      for (const f of page.files || []) {
        f.bytes = Number(f.quotaBytesUsed || f.size || 0);
        if (f.bytes < minBytes) return files; // sorted by size, so the rest are smaller
        files.push(f);
        if (files.length >= max) return files;
      }
      pageToken = page.nextPageToken;
      if (onProgress) onProgress(files.length);
    } while (pageToken);
    return files;
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
