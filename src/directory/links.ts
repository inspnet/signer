import { getUserByEmail, getUserById, listUsers, setPrimaryUserId } from "../db/index.js";
import type { DirectoryUser } from "./fields.js";

/**
 * Secondary mailboxes. One person often sends as several mailboxes: their
 * own, plus shared mailboxes for other companies in the group ("Dara Di Rocco
 * - Balfour Pacific", ddirocco@balfourpacific.com). Those mailboxes are their
 * own directory accounts, usually unlicensed and with few details filled in.
 *
 * Linking one to its person makes mail from it sign with the person's details
 * (name, title, phones, address, photo, everything they edit under My
 * Details) and the mailbox's own address. Rules still see the address it was
 * sent from, so a signature for balfourpacific.com applies; group rules see
 * the groups of both.
 */

export class LinkError extends Error {}

/** A secondary mailbox seen through its primary person: their details, its address. */
export function asLinked(mailbox: DirectoryUser, person: DirectoryUser): DirectoryUser {
  return {
    ...person,
    id: mailbox.id,
    email: mailbox.email,
    domain: mailbox.domain,
    source: mailbox.source,
    directoryId: mailbox.directoryId,
    enabled: mailbox.enabled,
    primaryUserId: person.id,
    groupIds: [...new Set([...person.groupIds, ...mailbox.groupIds])]
  };
}

/** The details a message from this address is signed with, or null when the address is not in the directory. */
export function senderProfile(email: string): DirectoryUser | null {
  const mailbox = getUserByEmail(email);
  if (!mailbox?.primaryUserId) return mailbox;
  const person = getUserById(mailbox.primaryUserId);
  return person ? asLinked(mailbox, person) : mailbox;
}

/** Link the mailbox at `email` to the person at `primaryEmail`, or unlink it when that is empty. */
export function linkMailbox(email: string, primaryEmail: string): DirectoryUser {
  const mailbox = getUserByEmail(email);
  if (!mailbox) throw new LinkError(`${email} is not in the directory.`);
  if (!primaryEmail.trim()) {
    setPrimaryUserId(mailbox.id, "");
    return getUserById(mailbox.id)!;
  }
  const person = getUserByEmail(primaryEmail);
  if (!person) throw new LinkError(`${primaryEmail} is not in the directory.`);
  if (person.id === mailbox.id) throw new LinkError("A mailbox cannot be linked to itself.");
  if (person.primaryUserId) {
    throw new LinkError(`${person.email} is itself linked to another person; link to that person instead.`);
  }
  if (listUsers().some((u) => u.primaryUserId === mailbox.id)) {
    throw new LinkError(`Other mailboxes are linked to ${mailbox.email}, so it is a primary person; unlink them first.`);
  }
  setPrimaryUserId(mailbox.id, person.id);
  return getUserById(mailbox.id)!;
}

export type LinkSuggestion = { email: string; displayName: string; primaryEmail: string; primaryName: string };

/** What separates a person's name from the company in a mailbox's display name. */
const SEPARATOR = /^\s*([-–—|:(]|\bat\b)/i;

/**
 * Mailboxes that look like a person's secondary mailbox: their display name
 * is the person's full display name followed by a separator and more
 * ("Dara Di Rocco - Balfour Pacific" under "Dara Di Rocco"). The longest
 * matching name wins, so "Ann Lee - X" is not offered to "Ann". Only
 * unlinked mailboxes, and names of two words or more, are considered.
 */
export function suggestLinks(users: DirectoryUser[] = listUsers()): LinkSuggestion[] {
  const isPrimary = new Set(users.map((u) => u.primaryUserId).filter(Boolean));
  const people = users
    .filter((u) => !u.primaryUserId && u.displayName.trim().split(/\s+/).length >= 2)
    .sort((a, b) => b.displayName.length - a.displayName.length);
  const out: LinkSuggestion[] = [];
  for (const mailbox of users) {
    if (mailbox.primaryUserId || isPrimary.has(mailbox.id)) continue;
    const name = mailbox.displayName.trim().toLowerCase();
    const person = people.find((p) => {
      if (p.id === mailbox.id) return false;
      const base = p.displayName.trim().toLowerCase();
      return name.startsWith(base) && name.length > base.length && SEPARATOR.test(name.slice(base.length));
    });
    if (!person) continue;
    out.push({ email: mailbox.email, displayName: mailbox.displayName, primaryEmail: person.email, primaryName: person.displayName });
  }
  return out;
}
