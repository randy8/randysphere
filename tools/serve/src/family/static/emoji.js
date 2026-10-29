// Emoji for reacting: a picker's worth, by category, plus a check that
// something typed is one emoji (any emoji — the keyboard's own is the
// full set; this list is only what's quick to tap). The server checks the
// same way (store.ts isEmoji).

export const QUICK = ['❤️', '👍', '👎', '😂', '‼️', '❓'];

export const CATEGORIES = [
  [
    'smileys',
    '😀 😃 😄 😁 😆 🥹 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🫡 🤐 🤨 😐 😑 😶 🫠 😏 😒 🙄 😬 😮‍💨 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖',
  ],
  [
    'people',
    '👋 🤚 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🫶 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 🫂 👀 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 👨‍👩‍👧 💃 🕺 🚶 🏃',
  ],
  [
    'hearts',
    '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 🎉 🎊 🎈 🎁 🏆 🥇',
  ],
  [
    'animals',
    '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦉 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🦀 🐠 🐬 🐳 🦈 🐘 🦒 🐕 🐈 🌸 🌹 🌻 🌷 🌱 🌲 🍀 🍁 🌈 ☀️ 🌙 ⛅ 🌧️ ❄️ ☃️ 🌊',
  ],
  [
    'food',
    '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🌶️ 🌽 🥕 🥔 🥐 🍞 🧀 🥚 🍳 🥞 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🥮 🍡 🍦 🍰 🎂 🧁 🍫 🍬 🍩 🍪 ☕ 🍵 🧋 🍺 🍷 🥂 🍾',
  ],
  [
    'activities',
    '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 ⛳ 🎣 🎿 🏂 🏊 🚴 🧘 🎮 🎲 🧩 🎯 🎳 🎨 🎬 🎤 🎧 🎹 🎸 🎻 📷 📚 ✏️ 💻 📱 ☎️ 💡 💰 🛒 🎓 💼 ✈️ 🚗 🚕 🚌 🚲 🚀 🛳️ 🏠 🏖️ 🏔️ 🗽 🏯 🎄 🎃',
  ],
  [
    'symbols',
    '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ❓ ❔ ❗ ‼️ ⁉️ 💤 ⚠️ 🚫 ⛔ 🆗 🆒 🆕 🆙 🔝 🔜 ♻️ ⏰ ⌛ 📌 📍 🔔 🎵 💬 💭 🗓️ 🇨🇳 🇺🇸 🇫🇷 🇯🇵 🏳️‍🌈',
  ],
].map(([name, list]) => [name, list.split(' ')]);

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** One emoji and nothing else (a pictograph with its modifiers, a flag, a keycap). */
export function isEmoji(text) {
  if (text.length === 0 || text.length > 16) return false;
  if ([...GRAPHEMES.segment(text)].length !== 1) return false;
  return (
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)/u.test(text) &&
    /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}]+$/u.test(text)
  );
}

const KEY = 'reactions-recent';

/** The emoji this device reacted with lately, newest first. */
export function recent() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((e) => typeof e === 'string' && isEmoji(e)) : [];
  } catch {
    return [];
  }
}

export function remember(emoji) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify([emoji, ...recent().filter((e) => e !== emoji)].slice(0, 16)),
    );
  } catch {
    // Private browsing: nothing remembered.
  }
}
