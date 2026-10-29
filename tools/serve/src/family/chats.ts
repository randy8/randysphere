/**
 * The chats this server runs. Each is a separate world — its own path,
 * database (private/<slug>/), accounts, sign-in cookie, notifications and
 * home-screen app — and nothing on one links to another. Another chat is
 * one entry here, one line in ../cli.ts, and its own accounts.
 */
export interface ChatIdentity {
  /** Its path (/<slug>/), its data directory (private/<slug>/), its cookie. */
  readonly slug: string;
  /** In the header, the tab, the home-screen title, an English notification. */
  readonly name: string;
  /** A Chinese-speaking member's notification title. */
  readonly zhName: string;
  /** The home-screen app's description. */
  readonly description: string;
}

export const FAMILY: ChatIdentity = {
  slug: 'family',
  name: 'Family',
  zhName: '家人',
  description: 'The family’s conversation · 家人的聊天',
};

export const DISC: ChatIdentity = {
  slug: 'disc',
  name: 'Disc',
  zhName: 'Disc',
  description: 'Disc',
};

export const CHATS: readonly ChatIdentity[] = [FAMILY, DISC];
