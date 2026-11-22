# WhatsApp Bulk Sender

Send one WhatsApp message to many numbers (up to 200). Each message is sent to each person separately, from **your own** WhatsApp.

There are two versions. Pick the one that fits you:

| | **Tap to Send** (web page) | **Automatic Sender** (Windows app) |
|---|---|---|
| Where | Any phone or computer, in the browser | A Windows 10 or 11 PC |
| Install | Nothing. Just open the link | Node.js (`start.bat` helps you install it) |
| Sending | You tap once per number | Sends by itself, one by one |
| Photo or file | No, text only | Yes, one image or file with a caption |
| Link | https://mfarahaaat.github.io/whatsapp-bulk-sender/ | Download this repo |

---

## 1. Tap to Send (web page)

**Open:** https://mfarahaaat.github.io/whatsapp-bulk-sender/

### How to use it
1. Open the link on your phone or computer.
2. **Phone numbers:** paste your numbers, one per line or separated by commas.
   - Numbers that start with `0` get the country code added. The default is `20` (Egypt). Change the box if your numbers are from another country.
   - Numbers with `+` or `00` are used as they are.
   - Duplicates are removed by themselves.
3. **Message:** write your message. WhatsApp styles work: `*bold*`, `_italic_`, `~strike~`.
4. **Open each chat in:**
   - **WhatsApp app**: best on phones. It opens the WhatsApp app.
   - **WhatsApp Web**: best on computers. It opens web.whatsapp.com in one tab. Log in there once with your phone.
5. Tap **Send to next**. WhatsApp opens with your message ready for the first number.
6. Tap **Send** in WhatsApp.
7. Come back to the page and tap **Send to next** again. Repeat until it says **All done**.

### Extra buttons
- **Skip**: jump over the next number without opening it.
- **Open** / **Again**: open a chat for one number on the list.
- **Start over**: mark every number as not opened and begin again.

The page remembers your numbers, message and progress on your device, so you can close it and continue later. Nothing is sent to any server. Your list stays in your browser.

---

## 2. Automatic Sender (Windows app)

It sends to every number by itself, waiting a few seconds between messages. You can attach one photo or file.

### Install (first time)
1. On this page, click the green **Code** button, then **Download ZIP**.
2. **Unzip it first:** right-click the zip and choose **Extract All**. Don't run it from inside the zip.
3. Open the unzipped folder and double-click **`start.bat`**.
   - If Node.js is missing, it asks to install it. Press **Y** and follow the steps, then double-click `start.bat` again.
   - The first start takes about a minute. It downloads what it needs.
4. Your browser opens the app at http://localhost:3000.

You need Google Chrome or Microsoft Edge. Edge comes with Windows.

### Connect your WhatsApp (first time only)
1. On your phone, open WhatsApp.
   - **iPhone:** Settings → Linked devices → Link a device
   - **Android:** ⋮ menu → Linked devices → Link a device
2. Scan the QR code on the page.
3. Wait until the badge at the top says **Connected**.

Next time you start the app, you won't need to scan again.

### Send messages
1. Double-click **`start.bat`**. Keep the black window open the whole time.
2. **Phone numbers:** paste up to 200, one per line or separated by commas. The same number rules as Tap to Send apply.
3. **Message:** write your message.
4. **Image or file** (optional): click **Choose file**, up to 30 MB. Your message becomes its caption.
5. **Wait between messages:** the default is a random 8–20 seconds. Longer waits are safer.
6. Click **Start sending** and confirm.
7. Watch each number's status:
   - **Sent**: the message went out.
   - **Not on WhatsApp**: the number has no WhatsApp account.
   - **Failed** or **Invalid**: something went wrong, or the number isn't valid.
8. When it's done, click **Download results (CSV)** to save the list. It opens in Excel.

You can click **Stop** at any time.

### Log out
Click **Log out** on the page. This unlinks your WhatsApp from this PC.

### If something goes wrong
| Problem | What to do |
|---|---|
| `start.bat` says "opened from inside the zip" | Unzip the folder first, then run `start.bat` from the unzipped folder. |
| The page says "App closed — start it again" | The black window was closed. Double-click `start.bat` again. |
| The QR code doesn't appear after a minute | Check your internet, close the black window, and start again. |
| Port 3000 is busy | Close other copies of the app, or set a different `PORT` (see below). |

---

## Please read: stay safe
- Messages go out from **your own** WhatsApp number.
- **Send only to people who know you** and expect your message. If many people block or report you, WhatsApp can ban your number.
- The Automatic Sender controls WhatsApp Web. It is **not an official WhatsApp tool**, so use long waits and small lists.
- Tap to Send only opens normal WhatsApp chats, so you press Send yourself every time.

---

## For developers

### Project files
```
docs/index.html       Tap to Send page (served by GitHub Pages from /docs)
server.js             Automatic Sender: web server + WhatsApp connection
public/index.html     Automatic Sender: the page you use at localhost:3000
start.bat             Windows launcher (checks Node.js, installs, starts)
START HERE.txt        Short steps for people who download the app
package.json          Node.js dependencies (express, multer, qrcode, whatsapp-web.js)
```

### Run from a terminal
```
npm install
npm start
```

### Settings (environment variables)
| Variable | What it does | Default |
|---|---|---|
| `PORT` | Port for the local page | `3000` |
| `CHROME_PATH` | Path to Chrome or Edge, if it's in an unusual place | found automatically |
| `SESSION_DIR` | Where the WhatsApp login is saved | `C:\Users\<you>\.wa-sender` |
| `NO_OPEN` | Set to `1` to not open the browser at start | not set |

### Notes
- The WhatsApp login is saved outside the project folder on purpose: deep Windows paths break Chrome's saved WhatsApp data.
- The app only listens on `127.0.0.1`, so other devices on your network can't open it.
- To update the Tap to Send page, edit `docs/index.html` and push to `main`. GitHub Pages updates the link within a minute.
