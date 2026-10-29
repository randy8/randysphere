import type { Hub } from './hub.ts';
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
  en: { title: 'Family', generic: 'New message', photo: 'Photo', voice: 'Voice message' },
  zh: { title: '家人', generic: '新消息', photo: '照片', voice: '语音消息' },
} as const;

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
  options: { preview: boolean; unread: number },
): PushPayload {
  const t = TEXT[recipient.lang];
  if (!options.preview) {
    return {
      title: t.title,
      body: t.generic,
      tag: 'family',
      messageId: message.id,
      badge: options.unread,
    };
  }
  const line = message.body.replace(/\s+/g, ' ').trim();
  const body = line !== '' ? [...line].slice(0, 140).join('') : message.image ? t.photo : t.generic;
  return {
    title: author?.displayName ?? t.title,
    body,
    tag: `family-${String(message.id)}`,
    messageId: message.id,
    badge: options.unread,
  };
}

export class Notifier {
  readonly #store: FamilyStore;
  readonly #hub: Hub;
  readonly #keys: VapidKeys;
  readonly #subject: string;
  readonly #fetch: typeof fetch | undefined;

  constructor(input: {
    store: FamilyStore;
    hub: Hub;
    keys: VapidKeys;
    subject: string;
    fetch?: typeof fetch;
  }) {
    this.#store = input.store;
    this.#hub = input.hub;
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
    const sends: Promise<void>[] = [];
    for (const recipient of this.#store.members()) {
      if (recipient.id === message.userId || recipient.disabledAt !== null) continue;
      if (this.#hub.isViewing(recipient.id)) continue;
      const targets = this.#store.pushTargets(recipient.id);
      if (targets.length === 0) continue;
      const unread = this.#store.unreadCount(recipient.id);
      for (const target of targets) {
        const payload = payloadFor(recipient, message, author, { preview: target.preview, unread });
        sends.push(
          sendPush(target, payload, {
            keys: this.#keys,
            subject: this.#subject,
            // Generic notifications collapse while a phone is offline: ten
            // undelivered "New message"s arrive as one.
            ...(target.preview ? {} : { topic: 'family' }),
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
