import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "signer-sentitems-"));
process.env.DATABASE_PATH = path.join(tmp, "sentitems.db");
process.env.DATA_DIR = tmp;
process.env.DEMO_MODE = "false";
process.env.SUPER_ADMIN_EMAIL = "it-admin@contoso.com";
process.env.PRIMARY_DOMAIN = "contoso.com";
process.env.SESSION_SECRET = "test-secret-test-secret-test-secret";
process.env.ENTRA_TENANT_ID = "tenant";
process.env.ENTRA_CLIENT_ID = "client";
process.env.ENTRA_CLIENT_SECRET = "secret";

const db = await import("../src/db/index.js");
const { emptyUser } = await import("../src/directory/fields.js");
const sent = await import("../src/mail/sentitems.js");

type Call = { method: string; url: string; headers: Headers; body?: unknown; bytes?: number };

const ORIGINAL = {
  id: "AAMk-original",
  subject: "Quarterly update",
  importance: "normal",
  sentDateTime: "2026-10-06T09:15:00Z",
  from: { emailAddress: { name: "Scott", address: "scott@contoso.com" } },
  sender: { emailAddress: { name: "Scott", address: "scott@contoso.com" } },
  toRecipients: [{ emailAddress: { name: "Ada", address: "ada@fabrikam.example" } }],
  ccRecipients: [{ emailAddress: { name: "Bob", address: "bob@contoso.com" } }],
  bccRecipients: [],
  replyTo: [],
  singleValueExtendedProperties: [{ id: "Binary 0x71", value: "AdcUEH8sYz7Q" }]
};

/** A fake mailbox: what Graph would hold and what Signer asked of it. */
let calls: Call[] = [];
let searches = 0;
let originalVisibleAfter = 1;
let createStatus = 201;
let uploadSessionStatus = 201;
let attachments: Array<{ "@odata.type": string; id: string; name: string; contentType: string; size: number; isInline: boolean; data: Buffer }> = [];
let uploaded = new Map<string, Buffer[]>();
let deleted: string[] = [];
/** Application permissions on the app token, as Entra puts them in its "roles" claim. */
let roles = ["User.Read.All", "Group.Read.All", "GroupMember.Read.All", "Mail.ReadWrite"];
const jwt = (claims: object) =>
  ["{}", JSON.stringify(claims), "sig"].map((p) => Buffer.from(p).toString("base64url")).join(".");

function stubGraph() {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes("/oauth2/v2.0/token")) return json({ access_token: jwt({ roles }) });
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call: Call = { method, url, headers };
    if (typeof raw === "string") call.body = JSON.parse(raw);
    else if (raw instanceof Uint8Array) call.bytes = raw.length;
    calls.push(call);

    if (url.startsWith("https://upload.example/")) {
      const name = url.split("/").pop()!;
      uploaded.set(name, [...(uploaded.get(name) ?? []), Buffer.from(raw as Uint8Array)]);
      const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(headers.get("content-range") ?? "")!;
      const last = Number(end) + 1 === Number(total);
      return new Response(last ? "{}" : JSON.stringify({ nextExpectedRanges: [`${Number(end) + 1}-`] }), { status: last ? 201 : 200 });
    }
    const p = url.replace("https://graph.microsoft.com/v1.0", "");
    if (method === "GET" && p.includes("/mailFolders/SentItems/messages?")) {
      searches += 1;
      return json({ value: searches > originalVisibleAfter ? [ORIGINAL] : [] });
    }
    if (method === "GET" && p.includes("/mailFolders/SentItems?")) return json({ id: "sentitems" });
    if (method === "POST" && p.endsWith("/mailFolders/SentItems/messages")) {
      return createStatus === 201
        ? json({ id: "AAMk-signed", isDraft: false }, 201)
        : json({ error: { message: "Access is denied." } }, createStatus);
    }
    if (method === "GET" && p.includes("/messages/AAMk-original/attachments?")) {
      return json({ value: attachments.map(({ data: _data, ...meta }) => meta) });
    }
    const one = /\/messages\/AAMk-original\/attachments\/([^/?]+)(\/\$value)?$/.exec(p);
    if (method === "GET" && one) {
      const att = attachments.find((a) => a.id === one[1])!;
      if (one[2]) return new Response(new Uint8Array(att.data), { headers: { "content-length": String(att.data.length) } });
      return json({ ...att, data: undefined, contentBytes: att.data.toString("base64") });
    }
    if (method === "POST" && /\/messages\/[^/]+\/attachments$/.test(p)) return json({ id: "att" }, 201);
    if (method === "POST" && p.endsWith("/attachments/createUploadSession")) {
      const name = (call.body as { AttachmentItem: { name: string } }).AttachmentItem.name;
      return uploadSessionStatus === 201
        ? json({ uploadUrl: `https://upload.example/${name}` }, 201)
        : json({ error: { message: "The item is not a draft." } }, uploadSessionStatus);
    }
    if (method === "POST" && p.endsWith("/permanentDelete")) {
      deleted.push(p.split("/messages/")[1]!.split("/")[0]!);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  });
}

type SignedCopy = import("../src/mail/sentitems.js").SignedCopy;
const copy = (note = ""): SignedCopy => ({
  html: `<p>Hello Ada</p><table><tr><td>Scott Williamson, Marketing Director</td></tr></table>${note}`,
  text: "Hello Ada\n\nScott Williamson",
  inline: [{ cid: "signer-logo-1", filename: "logo.png", contentType: "image/png", content: Buffer.from("PNGDATA") }]
});

beforeAll(() => {
  db.initDb();
  for (const [id, email] of [
    ["entra:scott", "scott@contoso.com"],
    ["entra:pat", "pat@contoso.com"]
  ] as const) {
    const user = emptyUser(email);
    user.id = id;
    user.source = "entra";
    db.upsertDirectoryUser(user);
  }
  db.replaceGroups(
    [
      { id: "g-pilot", name: "Signer pilot", email: "", source: "entra" },
      { id: "g-other", name: "Everyone else", email: "", source: "entra" }
    ],
    [
      { groupId: "g-pilot", userId: "entra:scott" },
      { groupId: "g-other", userId: "entra:pat" }
    ]
  );
});

beforeEach(() => {
  calls = [];
  searches = 0;
  originalVisibleAfter = 1;
  createStatus = 201;
  uploadSessionStatus = 201;
  attachments = [];
  uploaded = new Map();
  deleted = [];
  roles = ["User.Read.All", "Group.Read.All", "GroupMember.Read.All", "Mail.ReadWrite"];
  sent.resetSentItems();
  stubGraph();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  sent.saveSentItemsSettings({ enabled: true, groupIds: ["g-pilot"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => db.closeDb());

/** Move the clock, then let the real I/O behind it finish. */
async function run(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}
const created = () => calls.find((c) => c.method === "POST" && c.url.endsWith("/mailFolders/SentItems/messages"));
const queue = (sender = "scott@contoso.com", recipients = ["ada@fabrikam.example"], c = copy()) =>
  sent.queueSentItemsUpdate(sender, recipients, "<abc123@contoso.com>", c);
const fileAtt = (id: string, name: string, data: Buffer, size = data.length) => ({
  "@odata.type": "#microsoft.graph.fileAttachment",
  id,
  name,
  contentType: "application/octet-stream",
  size,
  isInline: false,
  data
});

describe("Sent Items update", () => {
  it("finds the original by Message-ID, adds the signed copy with its metadata, then removes the original", async () => {
    queue();
    await run(20_000); // first search: Outlook has not saved it yet
    expect(created()).toBeUndefined();
    await run(30_000);
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      "/users/scott@contoso.com/mailFolders/SentItems/messages?$filter=internetMessageId eq '<abc123@contoso.com>'"
    );

    const body = created()!.body as Record<string, unknown>;
    expect(body.subject).toBe("Quarterly update");
    expect((body.body as { content: string }).content).toContain("Scott Williamson, Marketing Director");
    expect(body.toRecipients).toEqual(ORIGINAL.toRecipients);
    expect(body.ccRecipients).toEqual(ORIGINAL.ccRecipients);
    expect(body.attachments).toEqual([
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "logo.png",
        contentType: "image/png",
        contentBytes: Buffer.from("PNGDATA").toString("base64"),
        isInline: true,
        contentId: "signer-logo-1"
      }
    ]);
    expect(body.singleValueExtendedProperties).toEqual([
      { id: "Integer 0x0E07", value: "1" },
      { id: "SystemTime 0x0039", value: "2026-10-06T09:15:00Z" },
      { id: "SystemTime 0x0E06", value: "2026-10-06T09:15:00Z" },
      { id: "String 0x1035", value: "<abc123@contoso.com>" },
      { id: "Binary 0x71", value: "AdcUEH8sYz7Q" }
    ]);
    expect(deleted).toEqual(["AAMk-original"]);
    expect(sent.recentSentItemsResults()[0]).toMatchObject({ result: "updated", sender: "scott@contoso.com" });
    expect(sent.pendingSentItems()).toBe(0);
  });

  it("copies attachments onto the signed copy, streaming large ones through an upload session", async () => {
    originalVisibleAfter = 0;
    const big = Buffer.alloc(9 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i += 7) big[i] = i & 0xff;
    attachments = [fileAtt("a1", "notes.txt", Buffer.from("small file")), fileAtt("a2", "survey.zip", big, big.length + 300)];
    queue();
    await run(20_000);

    const small = calls.find((c) => c.method === "POST" && c.url.endsWith("/messages/AAMk-signed/attachments"))!;
    expect(small.body).toMatchObject({ name: "notes.txt", contentBytes: Buffer.from("small file").toString("base64") });

    const session = calls.find((c) => c.url.endsWith("/messages/AAMk-signed/attachments/createUploadSession"))!;
    expect(session.body).toEqual({
      AttachmentItem: { attachmentType: "file", name: "survey.zip", size: big.length, contentType: "application/octet-stream", isInline: false }
    });
    const puts = calls.filter((c) => c.url.startsWith("https://upload.example/"));
    expect(puts.length).toBe(Math.ceil(big.length / sent.CHUNK));
    for (const put of puts.slice(0, -1)) expect(put.bytes! % (320 * 1024)).toBe(0);
    for (const put of puts) expect(put.headers.get("authorization")).toBeNull();
    expect(Buffer.concat(uploaded.get("survey.zip")!).equals(big)).toBe(true);
    expect(deleted).toEqual(["AAMk-original"]);
  });

  it("rolls back when an attachment cannot be copied: the signed copy goes, the original stays", async () => {
    originalVisibleAfter = 0;
    uploadSessionStatus = 400;
    attachments = [fileAtt("a2", "survey.zip", Buffer.alloc(5_000_000))];
    queue();
    await run(20_000);
    expect(deleted).toEqual(["AAMk-signed"]);
    expect(sent.recentSentItemsResults()[0]).toMatchObject({ result: "failed" });
    expect(sent.recentSentItemsResults()[0]!.detail).toMatch(/400.*not a draft/);
  });

  it("leaves messages with attached emails as sent", async () => {
    originalVisibleAfter = 0;
    attachments = [{ ...fileAtt("i1", "FW: thread", Buffer.alloc(0), 2000), "@odata.type": "#microsoft.graph.itemAttachment" }];
    queue();
    await run(20_000);
    expect(created()).toBeUndefined();
    expect(sent.recentSentItemsResults()[0]).toMatchObject({ result: "skipped" });
  });

  it("keeps the version that went outside when Exchange split the message", async () => {
    queue("scott@contoso.com", ["bob@contoso.com"], copy("<p>INTERNAL VERSION</p>"));
    queue("scott@contoso.com", ["ada@fabrikam.example"], copy("<p>EXTERNAL DISCLAIMER</p>"));
    originalVisibleAfter = 0;
    await run(20_000);
    expect((created()!.body as { body: { content: string } }).body.content).toContain("EXTERNAL DISCLAIMER");
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/mailFolders/SentItems/messages"))).toHaveLength(1);
  });

  it("only touches senders in the chosen groups, and nothing when it is off", async () => {
    queue("pat@contoso.com");
    queue("someone@elsewhere.example");
    sent.saveSentItemsSettings({ enabled: false, groupIds: [] });
    queue();
    await run(30 * 60_000);
    expect(calls).toEqual([]);
  });

  it("gives up when the original never shows up, without changing anything", async () => {
    originalVisibleAfter = 99;
    queue();
    await run(30 * 60_000);
    expect(searches).toBe(sent.SEARCH_DELAYS_MS.length);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    expect(sent.recentSentItemsResults()[0]).toMatchObject({ result: "not-found" });
  });

  it("explains a missing Mail.ReadWrite permission and never deletes the original", async () => {
    originalVisibleAfter = 0;
    createStatus = 403;
    queue();
    await run(20_000);
    expect(deleted).toEqual([]);
    expect(sent.recentSentItemsResults()[0]!.detail).toMatch(/403.*Mail\.ReadWrite/);
  });

  it("reads the Message-ID from the headers only", () => {
    expect(sent.messageIdOf(Buffer.from("Subject: hi\r\nMessage-ID: <x.1@contoso.com>\r\n\r\nbody"))).toBe("<x.1@contoso.com>");
    expect(sent.messageIdOf(Buffer.from("Subject: hi\r\n\r\nMessage-ID: <in-body@example.com>\r\n"))).toBe("");
  });

  it("runs the whole procedure on a throwaway message to check the tenant allows it", async () => {
    vi.useRealTimers();
    const result = await sent.checkSentItems("it-admin@contoso.com");
    expect(result.steps.map((s) => `${s.ok ? "ok" : "FAIL"} ${s.step}`)).toEqual([
      "ok Sign in as the Entra app",
      "ok Microsoft Graph permissions on the token",
      "ok Open it-admin@contoso.com's Sent Items",
      "ok Create a sent (not draft) message",
      "ok Attach a small file",
      "ok Attach a 3.5 MB file through an upload session",
      "ok Delete the test message"
    ]);
    expect(result.ok).toBe(true);
    expect(deleted).toEqual(["AAMk-signed"]);
  });

  it("reports which step the tenant refuses, and still cleans up", async () => {
    vi.useRealTimers();
    uploadSessionStatus = 400;
    const result = await sent.checkSentItems("it-admin@contoso.com");
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => !s.ok)).toMatchObject({ step: "Attach a 3.5 MB file through an upload session" });
    expect(result.steps.at(-1)).toMatchObject({ step: "Delete the test message", ok: true });
  });

  it("spots Mail.ReadWrite granted for Exchange Online instead of Microsoft Graph", async () => {
    vi.useRealTimers();
    roles = ["User.Read.All", "Group.Read.All", "GroupMember.Read.All"];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/v2.0/token")) return new Response(JSON.stringify({ access_token: jwt({ roles }) }));
      return new Response(JSON.stringify({ error: { message: "Access is denied. Check credentials and try again." } }), { status: 403 });
    });
    const result = await sent.checkSentItems("it-admin@contoso.com");
    expect(result.ok).toBe(false);
    expect(result.steps[1]).toMatchObject({ step: "Microsoft Graph permissions on the token", ok: true, warn: true });
    expect(result.steps[1]!.detail).toContain("it has: User.Read.All, Group.Read.All, GroupMember.Read.All");
    expect(result.hint).toMatch(/must be under "Microsoft Graph".*not under "Office 365 Exchange Online"/);
  });
});
