# Inbox & Drive Cleaner (Chrome extension)

Free up Google storage without paying for Google One:

- **Email cleanup**: set up rules once (e.g. "marketing from Meta"), then open the extension and run them. Every matching email is moved to Gmail's Trash.
- **Drive transfer**: move your biggest Drive files from an account that is full to another Google account that still has free space (every Google account gets 15 GB free).

Everything runs in your browser and talks directly to Google. There is no server.

## Email cleanup

1. **Find who fills your inbox.** Choose Promotions, Social, Updates, Forums, the inbox, or all mail, and how many recent emails to read. You get a list of senders with counts. Group by domain to see e.g. every `facebookmail.com` address as one row, and tick **Only mailing lists** to show only senders whose emails carry an unsubscribe link (newsletters and marketing).
2. **Tick the senders** you never want to see and click **Add selected as a rule**. You can also write rules by hand. A rule can match on:
   - **From**: addresses or whole domains, comma-separated
   - **Subject contains**
   - **Gmail category** (Promotions, Social, …)
   - **Older than** N days (e.g. keep the last week of deals, clean the rest)
   - **Larger than** N MB (big attachments use the most space)
   - **Keep starred / Keep important**: never touch those

   Each rule shows the exact Gmail search it runs. Paste it into Gmail's search box to see what it matches.
3. **Run**: **Find matching emails** shows how many emails each rule matches, with three examples each. **Move to Trash** trashes them all (counted once if several rules match).

Trashed emails can be restored for 30 days, after which Gmail deletes them and the space is freed. To free it at once, empty Gmail's Trash yourself.

Example rule, "Meta marketing": From `facebookmail.com, meta.com`, category Promotions, older than 7 days, keep starred. It runs:

```
from:(facebookmail.com OR meta.com) category:promotions older_than:7d -is:starred
```

## Drive transfer

1. Connect the **From** account (running out of space) and the **To** account (has free space). Each shows how much of its storage is used.
2. **Find large files** lists files owned by From, biggest first, above the size you choose.
3. Tick files, choose what happens to the originals, and click **Move selected**.

For each file, From shares it with To (without emailing), To makes its own copy inside Google (nothing is downloaded to your computer), the copy's checksum and size are compared with the original, and only then is the original trashed, deleted, or kept, as you chose. If anything fails, the original is left alone. Copies go into a folder named **Moved from <from-account>** in To's Drive.

- **Moved to Trash** (default) frees the space once Trash is emptied (Google does this after 30 days, or click **Empty "From" Drive Trash**).
- **Deleted permanently** frees the space straight away.
- **Kept** only copies.

Limitations: files are moved one at a time, without their folder structure. Files whose owner disabled copying for viewers can't be moved this way. Gmail, Drive and Google Photos share the same storage, so cleaning email also helps.

## Setup (once, about 10 minutes)

Gmail and Drive access needs an OAuth client from your own Google Cloud project. It's free.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library**: enable **Gmail API** and **Google Drive API**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, app name e.g. "Inbox & Drive Cleaner", your email as support and developer contact.
   - **Data access / Scopes**: add `.../auth/gmail.modify`, `.../auth/drive` and `email`.
   - **Audience / Test users**: add **every Google account you'll connect** (your Gmail account and both Drive accounts). Leave the app in **Testing**.
4. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this folder. Click the extension's toolbar icon; it opens on the **Setup** tab.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized redirect URIs**: paste the redirect URI shown on the extension's Setup tab (it looks like `https://<extension-id>.chromiumapp.org/`).
6. Copy the client ID (`….apps.googleusercontent.com`) into the Setup tab and click **Save**.
7. Connect your accounts on the **Email cleanup** and **Drive transfer** tabs. Google warns that the app isn't verified; that's expected for your own app in Testing. Click **Continue**.

The redirect URI depends on the extension's ID, which is tied to the folder you loaded it from. If you move the folder, update the redirect URI in Cloud Console.

## Privacy

- Your rules, client ID and connected account emails are stored in this browser only (`chrome.storage.local`).
- Sign-in tokens are kept in memory until Chrome closes (`chrome.storage.session`).
- Email contents are never read: only the From, Subject, Date and List-Unsubscribe headers.
- **Setup → Disconnect all accounts and delete saved data** signs everything out, revokes the tokens, and clears storage.

## Publishing to the Chrome Web Store

`gmail.modify` and `drive` are Google "restricted" scopes. Running it yourself (and for up to 100 test users you add) works as above. Offering it to the public requires Google's OAuth verification and a yearly third-party security assessment, which costs money. Narrower scopes (like `drive.file`) can't see existing files, so they can't do this job.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension manifest (MV3): `identity` and `storage` permissions |
| `background.js` | Toolbar button opens the app tab |
| `app.html` / `app.css` / `app.js` | The app: tabs, rules editor, file list |
| `lib/google.js` | Google sign-in per account (`launchWebAuthFlow`), API calls with retry |
| `lib/gmail.js` | Rules → Gmail search, sender scan, trash |
| `lib/drive.js` | Storage quota, large-file list, verified copy between accounts |
