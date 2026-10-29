import { FAMILY } from './chats.ts';
import type { ChatIdentity } from './chats.ts';
import type { Hub } from './hub.ts';
import { GLYPH } from './store.ts';
import type { FamilyStore, Message, User } from './store.ts';
import { sendPush } from './webpush.ts';
import type { VapidKeys } from './webpush.ts';

/**
 * Notifications for new messages, on phones and computers that asked for
 * them. Live delivery is still the event stream; this is for whoever
 * doesn't have the chat open.
 *
 * What a notification says is each device's own choice: by default only
 * "New message" (nothing of who or what, on a lock screen anyone can
 * glance at); with Preview on, the sender and the first line. Either way
 * the payload is encrypted for that one browser (webpush.ts) — Apple and
 * Google carry it without being able to read it.
 */

const TEXT = {
  en: { generic: 'New message', photo: 'Photo', voice: 'Voice message', sticker: 'Sticker' },
  zh: { generic: '新消息', photo: '照片', voice: '语音消息', sticker: '贴纸' },
} as const;

/** A message as one line: its text, its stickers left out; "Sticker" or "Photo" if that's all. */
function lineOf(message: Message, lang: 'en' | 'zh', max: number): string {
  const line = [...message.body.replaceAll(GLYPH, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, max)
    .join('');
  if (line !== '') return line;
  if (message.glyphs.length > 0) return TEXT[lang].sticker;
  return message.image ? TEXT[lang].photo : TEXT[lang].generic;
}

export function reactionPayload(
  recipient: User,
  message: Message,
  reactor: User,
  emoji: string,
  options: { preview: boolean; unread: number; chat?: ChatIdentity },
): PushPayload {
  const base = payloadFor(recipient, message, null, options);
  if (!options.preview) return base;
  const what = lineOf(message, recipient.lang, 80);
  return {
    ...base,
    title: reactor.displayName,
    body: recipient.lang === 'zh' ? `对“${what}”回应了 ${emoji}` : `Reacted ${emoji} to “${what}”`,
  };
}

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** One notification per conversation (generic) or per message (preview): what replaces what. */
  readonly tag: string;
  readonly messageId: number;
  readonly badge: number;
}

export function payloadFor(
  recipient: User,
  message: Message,
  author: User | null,
  options: { preview: boolean; unread: number; chat?: ChatIdentity },
): PushPayload {
  const t = TEXT[recipient.lang];
  const chat = options.chat ?? FAMILY;
  const title = recipient.lang === 'zh' ? chat.zhName : chat.name;
  if (!options.preview) {
    return {
      title,
      body: t.generic,
      tag: chat.slug,
      messageId: message.id,
      badge: options.unread,
    };
  }
  const body = lineOf(message, recipient.lang, 140);
  return {
    title: author?.displayName ?? title,
    body,
    tag: `${chat.slug}-${String(message.id)}`,
    messageId: message.id,
    badge: options.unread,
  };
}

export class Notifier {
  readonly #store: FamilyStore;
  readonly #hub: Hub;
  readonly #chat: ChatIdentity;
  readonly #keys: VapidKeys;
  readonly #subject: string;
  readonly #fetch: typeof fetch | undefined;

  constructor(input: {
    store: FamilyStore;
    hub: Hub;
    chat?: ChatIdentity;
    keys: VapidKeys;
    subject: string;
    fetch?: typeof fetch;
  }) {
    this.#store = input.store;
    this.#hub = input.hub;
    this.#chat = input.chat ?? FAMILY;
    this.#keys = input.keys;
    this.#subject = input.subject;
    this.#fetch = input.fetch;
  }

  get publicKey(): string {
    return this.#keys.publicKey;
  }

  /**
   * Notifies everyone but the author who isn't looking at the chat right
   * now. Never throws and never delays the send that caused it: the caller
   * doesn't await this for its response.
   */
  async messagePosted(message: Message): Promise<void> {
    const author = this.#store.getUser(message.userId);
    await this.#send(
      this.#store.members().filter((user) => user.id !== message.userId),
      (recipient, options) => payloadFor(recipient, message, author, options),
    );
  }

  /** A reaction on someone's message tells them (and only them), as iMessage does. */
  async reacted(message: Message, reactor: User, emoji: string): Promise<void> {
    if (message.userId === reactor.id) return;
    const author = this.#store.getUser(message.userId);
    if (!author) return;
    await this.#send([author], (recipient, options) =>
      reactionPayload(recipient, message, reactor, emoji, options),
    );
  }

  async #send(
    recipients: readonly User[],
    build: (
      recipient: User,
      options: { preview: boolean; unread: number; chat: ChatIdentity },
    ) => PushPayload,
  ): Promise<void> {
    const sends: Promise<void>[] = [];
    for (const recipient of recipients) {
      if (recipient.disabledAt !== null) continue;
      if (this.#hub.isViewing(recipient.id)) continue;
      const targets = this.#store.pushTargets(recipient.id);
      if (targets.length === 0) continue;
      const unread = this.#store.unreadCount(recipient.id);
      for (const target of targets) {
        const payload = build(recipient, {
          preview: target.preview,
          unread,
          chat: this.#chat,
        });
        sends.push(
          sendPush(target, payload, {
            keys: this.#keys,
            subject: this.#subject,
            // Generic notifications collapse while a phone is offline: ten
            // undelivered "New message"s arrive as one.
            ...(target.preview ? {} : { topic: this.#chat.slug }),
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
          }).then(({ outcome, status }) => {
            this.#store.recordPush(target.endpoint, outcome);
            if (outcome !== 'sent') {
              this.#hub.record(
                outcome === 'gone' ? 'push-subscription-expired' : 'push-failed',
                recipient.id,
                `${new URL(target.endpoint).hostname} ${String(status)}`,
              );
            }
          }),
        );
      }
    }
    await Promise.allSettled(sends);
  }
}
