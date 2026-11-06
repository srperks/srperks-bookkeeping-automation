# SR Perks Bookkeeping Automation

Supplier emails forwarded by bookkeeping clients are read, filed in SharePoint, renamed, moved out of the inbox, and (for bills) entered as **draft** bills in the right Xero organisation. Staff only review the draft and click **Submit for Approval**.

Runs as one small Node/TypeScript service on Railway (Node 22, set in `package.json` engines). Code on GitHub. Claude reads the PDFs.

## What happens to each email

The service checks `bookkeeping@srperks.com.au` every minute. Only mail from a configured client address is touched, and each address maps to exactly one SharePoint folder pair, one Outlook folder and one Xero organisation.

| Email contains | Result |
|---|---|
| PDF headed **Tax Invoice / Supplier Bill / Bill** | Saved in the client's financial-year and month folder, renamed `DD MM YYYY - Supplier - Bill Number.pdf`, one row added to the client's **Bills List** Excel, draft bill created in Xero with the PDF attached, email moved to the client's Outlook folder |
| PDF headed **Statement / Client Statement / Debtor Statement** | Saved in the client's financial-year and month folder (month of the as-at date), renamed `Supplier - YYYY MM DD.pdf`, email moved to the client's Outlook folder |
| Any other PDF, or no PDF | Left in the inbox, tagged `BK Left In Inbox` so it is not re-read |
| Looks like a bill/statement but something does not add up | Left in the inbox, tagged `BK Review`, alert email sent with the reason |

The email is moved only after **everything** for it has succeeded (SharePoint, Xero draft, PDF attached to the draft). If Xero is down, the email stays in the inbox and the next poll completes the job without creating duplicates.

## Where files go (financial-year and month folders)

`billsFolder` and `statementsFolder` are templates. `{FY}` becomes the Australian financial-year folder, named by the year the FY ends: bills from 1 Jul 2026 to 30 Jun 2027 go in `2027`, and a bill dated 1 Jul 2027 goes in `2028`, never `2027`. With `monthFolders: true` the file goes in the existing month folder inside it (October, Oct 2026, 10 October and similar names are recognised). The month is the bill's issue date (statements: the as-at date).

The service never creates folders. If the year or month folder is missing, or more than one folder looks like the month, the email stays in the inbox tagged `BK Review` with the reason. Create the folder and remove the category to retry.

## Bills List (Excel)

With `billsList` set, each bill adds one row to `Bills List.xlsx` in the year-level Accounts Payable folder, last, only after the PDF is saved and the Xero draft is created and checked. If anything stops the bill earlier, no row is written. The workbook must contain an **Excel table** (select the list, Insert > Table, tick "My table has headers"). Columns are matched by header text in any order: Supplier or Vendor, Date, Gross or Total, GST, Net, File Name, and optionally Invoice number and Due date. Columns the service does not know (for example Year, Quarter, Category) are left untouched for staff. Supplier, date and total are required, plus either an invoice-number column or a File Name column, so a bill is never listed twice (without a number column the saved file name identifies it). If the columns cannot be matched, nothing is written and an alert names the columns it found.

**Scanned copies.** A scanned (image-only) PDF is accepted when Claude reads its heading with at least medium confidence. Its Bills List row is coloured light red with dark red text, and the text "Scanned copy, check carefully" is written to a Notes or Comments column if the list has one. If the colouring call fails, the row is still written and a warning is logged.

**Names.** Supplier names are written in proper case in file names, the Bills List and Xero ("FLICK ANTICIMEX PTY LTD" becomes "Flick Anticimex Pty Ltd"). Names that already mix upper and lower case are only corrected for legal forms (Pty, Ltd, Limited and so on).

**Unconfirmed suppliers.** If the supplier on a bill cannot be matched in Xero with certainty (a similar but not identical contact, two contacts with the same name, or the same name with a different ABN), the system does not stop. The PDF is saved and the Bills List row is written as usual, and the Xero draft bill is created under a placeholder contact named "Unconfirmed Supplier - choose the correct contact", with the Reference field set to "CHECK SUPPLIER: <name on the bill>". Staff pick the right contact on the draft. The Bills List Notes column (if present) says the supplier is to be confirmed.

**Receipts.** To treat receipts as bills, add `"receipt"` and `"tax receipt"` to `rules.extraBillHeadings` in `CLIENTS_JSON`. A PDF holding several receipts is still held for review, because it contains more than one document.

Excel is reached by the file's item ID, not its path, because path-based Excel calls fail with 403 "Could not obtain a WAC access token" on some tenants.

## Why it is accurate

A wrong filing costs more than a manual one, so anything uncertain stops for a human instead of being guessed.

1. **Two independent readings of the heading.** The PDF's own text layer is read deterministically and Claude reads the page. The document is only treated as a bill or statement when both agree. Disagreement goes to review.
2. **Strict heading rules.** The heading must be the heading ("Tax Invoice #123" yes, "Bill To", "Bill Date", "Statement Date" no). Only the top of page 1 counts, so a statement listing invoices is never mistaken for an invoice.
3. **Two extraction passes.** Each bill is extracted twice, independently. Supplier, bill number, dates, GST, total and line amounts must match exactly or the bill goes to review.
4. **Arithmetic checks.** Lines must add to the subtotal, subtotal plus GST must equal the total, and GST must equal 10% of the GST-applicable lines (or one eleventh if prices include GST).
5. **Date checks.** Dates are read day-first (Australian). The printed date string is re-parsed in code and compared with the extracted date, which catches day/month swaps. Future issue dates and due-before-issue are rejected.
6. **Xero confirmation.** After the draft is created, Xero's total and GST are compared with the PDF. Any difference stops the email for review.
7. **No guessing on suppliers.** An exact name match uses the existing Xero contact. A name that is close but not the same (for example "Acme Foods" vs "Acme Foods Wholesale") stops for review rather than creating a duplicate or picking wrongly. A genuinely new supplier is created.
8. **Duplicates.** A bill already processed (in the Bills List, in Xero under any supplier with the same number and total, or filed in SharePoint) is flagged "DUPLICATE BILL" and left in the inbox with BK Review: no Bills List row, no second draft. A different PDF of it is kept as `... (2).pdf`. Nothing is ever overwritten.
9. **Spoofing.** Mail that fails DMARC is stopped before anything is read.
10. **Drafts only.** The service can only create bills with status `DRAFT`. It cannot submit or approve.

## Setup

### 1. Microsoft 365
1. Entra admin centre, App registrations, new app. Add a client secret.
2. API permissions, **Application** permissions, grant admin consent: `Mail.ReadWrite`, `Mail.Send`, `Sites.ReadWrite.All` (or `Sites.Selected` limited to the bookkeeping site), `Files.ReadWrite.All` (not needed if using `Sites.Selected`).
3. Restrict the app to the one mailbox (recommended). In Exchange Online PowerShell:
   ```
   New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId <email of a mail-enabled security group that contains only bookkeeping@srperks.com.au> -AccessRight RestrictAccess -Description "Bookkeeping automation"
   ```
4. In the bookkeeping mailbox, create the two Outlook folders (for example `Inbox/Hopper Joint`, `Inbox/Harcourts Cafe`).
5. In SharePoint create the bills and statements folders for each client. The service never creates folders, so a typo shows up as a clear error instead of a stray folder.

### 2. Xero
Authorisation runs on the deployed service, so nothing is done on localhost.
1. In Railway, open the service, Settings, Networking, **Generate Domain**. Note the address, for example `https://srperks-bookkeeping.up.railway.app`.
2. Create a **separate Xero app** for this service (do not reuse the MCP connector's app). Set the redirect URI to `https://<your-railway-domain>/xero/callback`. Copy the Client ID, generate a secret, and set `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` in Railway.
3. In Railway also set `XERO_REDIRECT_URI` to that same redirect URI, and `XERO_SETUP_KEY` to a long random value (16+ characters). The service needs a `CLIENTS_JSON` to start, so use the placeholder mapping first (placeholder tenant IDs are fine at this point).
4. After the redeploy, open `https://<your-railway-domain>/xero/connect?key=<XERO_SETUP_KEY>`, sign in to Xero as a user with access to **both** client organisations (and the Demo Company for testing), tick them and allow. The page lists each organisation's tenant ID and the login is saved on the Railway volume.
5. Put the tenant IDs into `CLIENTS_JSON`, then **delete `XERO_SETUP_KEY`** to switch the setup page off.
6. Xero refresh tokens rotate on every use, so the Railway **volume mounted at `/data`** (with `TOKEN_STORE_PATH=/data/xero-tokens.json`) must stay attached.
7. Scopes default to the granular set (`accounting.invoices accounting.contacts accounting.attachments accounting.settings.read`), which is what apps created from March 2026 use. An older app can set `XERO_SCOPES` to use `accounting.transactions` instead of `accounting.invoices`.
8. Each client needs a default expense account code (`defaultAccountCode`) unless every supplier contact has a default purchases account in Xero. The service uses the contact's default first, then the client default. If neither exists the draft lines have no account and staff must code them.

(`npm run xero:auth` still exists as a local alternative if you ever prefer it.)

### 3. Railway
- Deploy from GitHub. Set the variables from `.env.example`. **Keep the service at one replica.**
- Set `CLIENTS_JSON` to the single-line JSON from `config/clients.example.json`. This is the only thing that changes between testing and live.

## Test first, then go live

1. **Accuracy check on real documents (no accounts needed, only `ANTHROPIC_API_KEY`):**
   `npm run extract -- samples/*.pdf`
   Prints, for each PDF, what the service would do: file as bill, file as statement, leave in inbox, or stop for review, with the file name and every extracted number. Run it on 5 to 10 real emails from each client, including statements, and compare with the PDFs by eye.
2. **Dry run against the real mailbox:** `DRY_RUN=true` (the default). Reads everything, writes nothing. Check the Railway logs for the "Dry run result" lines.
3. **Test destinations:** point `CLIENTS_JSON` at test SharePoint folders, a test Outlook folder and the **Xero Demo Company** (connect it in step Xero 2). For testing you can list your own email address as a sender. Set `DRY_RUN=false` and `PROCESS_FROM` to the current time.
4. `npm run preflight` checks every connection and destination without writing anything.
5. **Go live:** swap `CLIENTS_JSON` to the real folders and the two real Xero tenant IDs, set `PROCESS_FROM` to the go-live moment (mail already in the inbox before then is never touched), keep `DRY_RUN=false`.

## Log workbook (optional)
`npm run make-log-template` creates `Bookkeeping Log.xlsx` with the `BookkeepingLog` table. Upload it to SharePoint at the path in `log.filePath`. Every filed or stopped document adds a row with the file name, Xero draft link and notes.

## Daily operation
- **Alerts** go to `ALERT_EMAILS` whenever an email needs a look. Each alert says why.
- **Outlook categories** are the service's memory. To make it try an email again, remove its `BK Review`, `BK Error`, `BK Left In Inbox` or `BK Partial` category.
- A `BK Partial` email had a bill or statement (handled) plus a PDF that is neither, so it stays for a person to look at.
- `GET /health` reports last poll time.

## Known limits
- Only headings in the brief are recognised. "Invoice" on its own, "Customer Statement" and "Account Statement" are treated as unrecognised and left in the inbox. Add them to `rules.extraBillHeadings` / `rules.extraStatementHeadings` in the client mapping once agreed.
- A bill with a different currency, a negative total (credit note) or a scanned image that Claude is not highly confident about stops for review.
- Emails forwarded "as attachment" (an attached email rather than an attached PDF) are flagged, not opened.
- Only the first 100 pages of a PDF are read, and PDFs over 30 MB go to review.
- Mail older than `LOOKBACK_DAYS` (default 7) is ignored if the service was down for longer than that.

## Commands
```
npm run extract -- file.pdf   # accuracy tester, no side effects
npm run xero:auth             # one-time Xero authorisation (both organisations)
npm run preflight             # verify all connections and destinations
npm run make-log-template     # create the Excel log
npm test                      # 105 automated tests
npm run build && npm start    # production
```
