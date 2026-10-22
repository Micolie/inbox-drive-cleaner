# Inbox & Drive Cleaner (Chrome extension)

Free up Google storage without paying for Google One:

- **Unsubscribe**: stop marketing emails at the source, in bulk, using each sender's own unsubscribe option.
- **Email cleanup**: set up rules once (e.g. "marketing from Meta"), then run them yourself or let them run automatically every day or week. Every matching email is moved to Gmail's Trash.
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

### Unsubscribe

After **Find senders**, the **Unsubscribe** column shows how each sender can be unsubscribed. This comes from the `List-Unsubscribe` header that mailing lists include, the same one Gmail's own Unsubscribe button uses:

- **1-click**: the extension sends the standard one-click unsubscribe request (RFC 8058) straight to the sender.
- **email**: the extension sends the unsubscribe email the sender asks for, from your Gmail account.
- **web page**: the sender only offers a page. It opens in a background tab for you to finish.

Tick senders and click **Unsubscribe from selected**. With **and add a rule to clean up their old emails** ticked (the default), a rule for those senders is added too, so the next run also trashes what they already sent. Senders you've unsubscribed from are remembered and marked in the list. Senders can take a few days to stop.

Only unsubscribe from senders you recognize. For spam, unsubscribing confirms your address is real; trash those instead. (The sender scan never looks in Spam.)

### Automatic cleanup

Under **4. Automatic cleanup**, tick **Clean up automatically** and choose **every day** or **every week** and a time. The extension then runs your switched-on rules by itself and moves the matches to Trash. You get a notification when it trashes something (you can turn that off) or when something goes wrong. **Run automatic cleanup now** runs it straight away so you can see it work.

- Chrome needs to be open. If Chrome was closed at that time, the cleanup runs next time you open it.
- **Safety limit** (default 1,000): if more emails match than that, nothing is trashed and you're told, so a bad rule can't empty your mailbox. For a big first clean-up, use **3. Run** by hand.
- It never pops up a sign-in window. If Google wants you to sign in again, you get a notification; open the app and reconnect the Gmail account.

Trashed emails can be restored for 30 days, after which Gmail deletes them and the space is freed. To free it at once, empty Gmail's Trash yourself.

Example rule, "Meta marketing": From `facebookmail.com, meta.com`, category Promotions, older than 7 days, keep starred. It runs:

```
from:(facebookmail.com OR meta.com) category:promotions older_than:7d -is:starred
```

## Drive transfer

1. Connect the **From** account (running out of space) and the **To** account (has free space). Each shows how much storage is used and what by: Drive files, Drive Trash, and Gmail & Photos. Only Drive files can be moved here. If Drive Trash is big, empty it. If Gmail & Photos is big, use Email cleanup (large-attachment rules help most).
2. **Find large files** checks every file owned by From and lists those above the size you choose, biggest first. With many thousands of files this takes a little while.
3. Tick files, choose what happens to the originals, and click **Move selected**.

For each file, From shares it with To (without emailing), To makes its own copy inside Google (nothing is downloaded to your computer), the copy's checksum and size are compared with the original, and only then is the original trashed, deleted, or kept, as you chose. If anything fails, the original is left alone. Copies go into a folder named **Moved from <from-account>** in To's Drive.

- **Moved to Trash** (default) frees the space once Trash is emptied (Google does this after 30 days, or click **Empty "From" Drive Trash**).
- **Deleted permanently** frees the space straight away.
- **Kept** only copies.

Limitations: files are moved one at a time, without their folder structure. Files whose owner disabled copying for viewers can't be moved this way. Gmail, Drive and Google Photos share the same storage, so cleaning email also helps.

## Setup (once, about 15 minutes)

Gmail and Drive access needs a sign-in client from your own Google Cloud project. It's free.

**A. Load the extension** (you need its redirect URI for step D)

1. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and pick this folder.
2. Click the extension's toolbar icon. It opens on the **Setup** tab. Leave it open.

**B. Create a project and turn on the APIs**

1. Go to [console.cloud.google.com](https://console.cloud.google.com/). In the project picker at the top, click **New project**, name it e.g. `inbox-cleaner`, click **Create**, and make sure it's selected.
2. Open [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) and click **Enable**.
3. Open [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) and click **Enable**.

**C. Configure Google Auth Platform** (the page that says *"Google Auth Platform not configured yet"*)

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and click **Get started**.
2. **App information**: App name `Inbox & Drive Cleaner`, User support email = your email. **Next**.
3. **Audience**: choose **External**. **Next**.
4. **Contact information**: your email. **Next**.
5. **Finish**: tick the agreement, click **Continue**, then **Create**.
6. In the left menu, click **Audience**. Under **Test users**, click **Add users** and add **every Google account you'll connect** (your Gmail account and both Drive accounts). **Save**. Leave the publishing status on **Testing**.

**D. Create the client ID**

1. In the left menu, click **Clients**, then **Create client**.
2. Application type: **Web application**. Name: anything.
3. Under **Authorized redirect URIs**, click **Add URI** and paste the redirect URI from the extension's Setup tab (it looks like `https://abcdefghijklmnop.chromiumapp.org/`). Leave **Authorized JavaScript origins** empty.
4. Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You don't need the client secret.
5. Paste the client ID into the extension's Setup tab and click **Save**.

**E. Connect your accounts** on the **Email cleanup** and **Drive transfer** tabs. Google shows *"Google hasn't verified this app"*: that's expected for your own app in Testing. Click **Continue**, then allow access.

If sign-in fails:

- **Error 400: redirect_uri_mismatch**: the redirect URI in Clients doesn't exactly match the Setup tab (check the trailing `/`). The extension ID, and so the URI, changes if you load the extension from a different folder.
- **Error 403: access_denied**: the account isn't in **Audience → Test users**.
- **Error 401: invalid_client**: the client ID was pasted wrong, or you created a client of a type other than Web application.

## Privacy

- Your rules, client ID and connected account emails are stored in this browser only (`chrome.storage.local`).
- Sign-in tokens are kept in memory until Chrome closes (`chrome.storage.session`).
- Email contents are never read: only the From, Subject, Date, List-Unsubscribe and List-Unsubscribe-Post headers.
- The only emails the extension sends are unsubscribe emails, to senders you chose to unsubscribe from.
- **Setup → Disconnect all accounts and delete saved data** signs everything out, revokes the tokens, and clears storage.

## Publishing to the Chrome Web Store

`gmail.modify` and `drive` are Google "restricted" scopes. Running it yourself (and for up to 100 test users you add) works as above. Offering it to the public requires Google's OAuth verification and a yearly third-party security assessment, which costs money. Narrower scopes (like `drive.file`) can't see existing files, so they can't do this job.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension manifest (MV3): `identity`, `storage`, `alarms` and `notifications` permissions |
| `background.js` | Toolbar button opens the app tab; runs the automatic cleanup on a timer |
| `app.html` / `app.css` / `app.js` | The app: tabs, rules editor, file list |
| `lib/google.js` | Google sign-in per account (`launchWebAuthFlow`), API calls with retry |
| `lib/gmail.js` | Rules → Gmail search, sender scan, unsubscribe, trash |
| `lib/drive.js` | Storage quota, large-file list, verified copy between accounts |
