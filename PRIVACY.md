# Privacy and data retention

Signer adds email signatures and disclaimers to outgoing mail on a server that
your organisation runs. This statement describes what Signer does with the
mail and personal data that pass through it, and how long anything is kept.
It covers the software as shipped, with the retention settings left at their
defaults and installed with `deploy/install.sh` from this repository.

**In short:** Signer does not keep your email. Messages are processed in
memory and handed straight back to Microsoft 365 or Google Workspace. What
Signer does keep is limited to what it needs to work: a 30-day log of who sent
mail to whom, and a copy of directory details (name, job title, phone number)
to fill in signatures. Both are deleted on a fixed schedule.

## Email content is never stored

- Message bodies, subject lines, attachments and headers are **never written
  to disk**, to the database or to logs. Each message is held in memory only
  while the signature is added, and is gone once it has been handed back.
- Signer confirms receipt of a message only **after Microsoft or Google has
  accepted it back**. Until then the message stays in your provider's queue.
  If Signer cannot hand a message back, it refuses it with a temporary error
  (SMTP 451) and your provider retries later. Signer is never the only holder
  of a message, and a message cannot be lost inside it.
- The rule tester in the admin portal works on text typed into the page. It
  does not send that text anywhere and does not store it.

## What is stored, and for how long

| Data | Why it is kept | How long |
| --- | --- | --- |
| **Activity log**: the time, the sender's address, the recipients' addresses, which signature, disclaimer or campaign was applied, the outcome, the processing time, and the error text when something failed | The Activity page, and troubleshooting delivery problems | **30 days**, then deleted automatically (`MAIL_LOG_RETENTION_DAYS`) |
| **Directory details** copied from Microsoft Entra ID or Google Workspace: name, job title, department, company, office, office address, phone, mobile and fax numbers, plus any fields staff fill in themselves (pronouns, social links and so on) | To fill in each person's signature | While the person is in your directory. Someone deleted from Entra or Google is removed at the next directory sync, every 4 hours by default. A suspended or disabled account is kept, marked disabled, until it is deleted |
| **Admin audit trail**: which administrator changed which signature, rule or role, and when | Accountability for changes to what is added to company mail | **365 days**, then deleted automatically (`AUDIT_LOG_RETENTION_DAYS`) |
| **Portal roles**: the email addresses of people granted admin, editor or designer access | Access control | Until an administrator removes them |
| **Signature designs, rules, disclaimers, campaigns and uploaded artwork** | They are the product's configuration | Until an administrator deletes them |
| **Server logs**: each request to the portal or to images served by Signer, with the client's IP address and browser details, and error messages, which can include email addresses | Security and troubleshooting | **14 days** (system journal) |
| **Backups** of the database and uploaded artwork | Recovery after a failure | **14 days**, on the server. If Linode Backups is enabled, also on Linode's backup schedule |

When a row is deleted, the database overwrites the data rather than leaving it
recoverable in unused space in the file. Deleted data can still exist in a backup until that
backup expires, up to 14 days later.

Signer also keeps a copy of the IP address ranges that Microsoft and Google
publish for their mail servers. This is public information, not personal data.

Sign-in uses a signed cookie that expires after 12 hours. Sessions are not
stored on the server.

## Where the data is and who can see it

- Everything above is stored on the one server that runs Signer, in the
  Linode region chosen when it was set up. Linode (Akamai) is the hosting
  provider.
- Only people your administrators grant access to can sign in to the portal.
  Signing in goes through your own Microsoft or Google accounts.
- **Signer sends no data to its authors or to any third-party service.** It has
  no telemetry, analytics or usage reporting.

The server makes outbound connections only for these purposes:

| To | Why | What is sent |
| --- | --- | --- |
| Microsoft 365 / Exchange Online, or Google Workspace | Returning signed mail | The message, back to the provider it came from |
| Microsoft Entra ID / Graph, or Google Workspace Admin APIs | Sign-in, and directory sync | Sign-in requests; directory reads (read-only) |
| DNS | Looking up the mail server ranges Microsoft and Google publish | No personal data |
| Let's Encrypt | Issuing and renewing the HTTPS certificate | The server's hostname, and the super admin's email address as the account contact for expiry notices |
| GitHub, npm, NodeSource, Ubuntu mirrors | Installing and updating the software, only when the install script runs (and Ubuntu's automatic security updates) | No personal data |

Two outside services are contacted by browsers and mail clients, not by the
server itself:

- **Google Fonts.** The admin portal loads its typeface from Google, so an
  administrator's browser contacts Google when the portal opens.
- **jsDelivr.** If a signature includes social media icons, the icons are
  loaded from the jsDelivr CDN. A recipient's mail client that displays images
  will contact jsDelivr when the message is opened.

## No tracking

Signer does not track recipients:

- No tracking pixels.
- No per-recipient or per-message links. Banner and campaign links go straight
  to their destination.
- No open or click tracking.

Images in a signature have the same address in every message. If a recipient's
mail client loads an image that Signer serves, that request appears in the
14-day server log like any other web request, with the client's IP address. It
cannot be tied to a particular message or recipient.

## Removing someone's data

- **A member of staff who leaves:** delete them in Entra ID or Google Workspace.
  The next directory sync removes their details from Signer.
- **A request to erase someone's data from the activity log** (as sender or
  recipient) before the 30 days are up: an administrator with server access
  can run:

  ```bash
  sudo -u signer sqlite3 /var/lib/signer/signer.db \
    "DELETE FROM mail_log WHERE lower(sender) = 'person@example.com' OR recipients LIKE '%\"person@example.com\"%';"
  ```

  Copies in backups expire within 14 days.
- **Taking Signer out of service:** delete the Linode, and its Linode Backups
  if they were enabled. That removes all data Signer held.

## Changing the defaults

`MAIL_LOG_RETENTION_DAYS` and `AUDIT_LOG_RETENTION_DAYS` can be changed in the
server's environment. Setting either to `0` keeps that log indefinitely. If you
change them, or change how backups or logs are kept, update this statement to
match.
