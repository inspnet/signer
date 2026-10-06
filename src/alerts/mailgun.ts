/**
 * Sends through Mailgun's HTTP API (https://documentation.mailgun.com), over
 * HTTPS on 443. Alerts must not depend on the SMTP path they report on: when
 * port 25 is blocked or Exchange refuses Signer, an alert sent through either
 * would fail the same way.
 */

export type MailgunAccount = { apiKey: string; domain: string; region: "us" | "eu" };
export type MailgunMessage = { from: string; to: string[]; subject: string; text: string };

export function mailgunBase(region: MailgunAccount["region"]): string {
  return region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
}

export async function sendMailgun(account: MailgunAccount, message: MailgunMessage): Promise<{ id: string }> {
  const body = new URLSearchParams();
  body.set("from", message.from);
  for (const to of message.to) body.append("to", to);
  body.set("subject", message.subject);
  body.set("text", message.text);
  body.set("o:tag", "signer-alert");

  let res: Response;
  try {
    res = await fetch(`${mailgunBase(account.region)}/v3/${encodeURIComponent(account.domain)}/messages`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`api:${account.apiKey}`).toString("base64")}` },
      body,
      signal: AbortSignal.timeout(15_000)
    });
  } catch (err) {
    throw new Error(`Could not reach Mailgun: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401
        ? " Check the API key: a domain sending key for this domain, or the account's private API key."
        : res.status === 404
          ? ` Mailgun has no domain ${account.domain} in the ${account.region.toUpperCase()} region: check the domain and region.`
          : res.status === 403
            ? " The domain may not be verified yet, or the account is restricted to authorised recipients."
            : "";
    throw new Error(`Mailgun answered ${res.status}: ${text.slice(0, 300).trim()}.${hint}`);
  }
  let id = "";
  try {
    id = String((JSON.parse(text) as { id?: string }).id ?? "");
  } catch {
    /* Mailgun answers JSON; an id is a nicety */
  }
  return { id };
}
