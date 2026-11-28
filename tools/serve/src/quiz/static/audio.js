// Sound for the audience display and single player. Every cue has an
// original synthesised default (Web Audio, nothing downloaded), and a
// theme can name a file to use instead (theme.json "audio": { cue: url }) —
// licensed recordings live in private/quiz/themes/<name>/, never in this
// repository. One music channel (a new piece stops the last), one effects
// channel, and narration through the browser's speech synthesis.
//
// Browsers start audio only after a gesture on the page, so the display
// asks for one click (or key) before anything plays: `unlock()`.

const CUES = [
  'board_fill',
  'category',
  'wager_reveal',
  'time_up',
  'round_end',
  'buzz',
  'final_think',
  'game_over',
];

const note = (midi) => 440 * 2 ** ((midi - 69) / 12);

export class Audio {
  constructor(theme = {}) {
    this.ctx = null;
    this.theme = theme;
    this.buffers = new Map();
    this.music = null;
    this.musicGain = null;
    this.enabled = true;
    this.volume = 0.8;
  }

  /** Must be called from a user gesture. Loads any theme recordings. */
  async unlock() {
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return false;
      this.ctx = new Context();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.preload();
    return this.ctx.state === 'running';
  }

  async preload() {
    const audio = this.theme.audio ?? {};
    await Promise.all(
      CUES.filter((cue) => typeof audio[cue] === 'string' && !this.buffers.has(cue)).map(
        async (cue) => {
          try {
            const response = await fetch(audio[cue]);
            const data = await response.arrayBuffer();
            this.buffers.set(cue, await this.ctx.decodeAudioData(data));
          } catch {
            // Falls back to the synthesised cue.
          }
        },
      ),
    );
  }

  get ready() {
    return this.enabled && this.ctx?.state === 'running';
  }

  /** Plays a cue. `offsetMs` starts music partway in (a late-joining display). */
  play(cue, offsetMs = 0) {
    if (!this.ready) return;
    const isMusic = cue === 'final_think';
    if (isMusic) this.stopMusic();
    const out = this.ctx.createGain();
    out.connect(this.master);
    if (isMusic) {
      this.musicGain = out;
    }
    const buffer = this.buffers.get(cue);
    if (buffer) {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(out);
      source.start(0, Math.min(buffer.duration, offsetMs / 1000));
      if (isMusic) this.music = source;
      return;
    }
    const synth = SYNTH[cue];
    if (synth) synth(this.ctx, out, this.ctx.currentTime + 0.02, offsetMs / 1000);
  }

  stopMusic() {
    if (this.musicGain && this.ctx) {
      const gain = this.musicGain.gain;
      gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      const old = this.musicGain;
      setTimeout(() => old.disconnect(), 600);
    }
    try {
      this.music?.stop();
    } catch {
      // Already stopped.
    }
    this.music = null;
    this.musicGain = null;
  }

  /**
   * Reads text aloud; resolves when finished (or, if speech isn't
   * available or stalls, after a reading-length pause). Never overlaps:
   * anything still speaking is cancelled first.
   */
  speak(text, rate = this.theme.narration?.rate ?? 1) {
    const fallback = Math.min(20000, 1200 + text.length * 70);
    if (!('speechSynthesis' in window) || !this.enabled) return Promise.resolve(false);
    return new Promise((resolve) => {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = rate;
      const voice = speechSynthesis
        .getVoices()
        .find((candidate) => candidate.lang?.startsWith('en') && candidate.localService);
      if (voice) utterance.voice = voice;
      let done = false;
      const finish = (spoken) => {
        if (done) return;
        done = true;
        resolve(spoken);
      };
      utterance.addEventListener('end', () => finish(true));
      utterance.addEventListener('error', () => finish(false));
      setTimeout(() => finish(false), fallback * 1.6);
      speechSynthesis.speak(utterance);
    });
  }

  silence() {
    this.stopMusic();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
}

// ---------------------------------------------------------------------------
// The original cues. Simple voices: an envelope over an oscillator.

function tone(
  ctx,
  out,
  {
    at,
    freq,
    dur,
    type = 'sine',
    peak = 0.25,
    attack = 0.01,
    release = 0.2,
    detune = 0,
    filter = null,
  },
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  osc.detune.value = detune;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + attack);
  gain.gain.setValueAtTime(peak, at + Math.max(attack, dur - release));
  gain.gain.linearRampToValueAtTime(0, at + dur);
  let node = osc;
  if (filter) {
    const biquad = ctx.createBiquadFilter();
    biquad.type = 'lowpass';
    biquad.frequency.value = filter;
    osc.connect(biquad);
    node = biquad;
  }
  node.connect(gain);
  gain.connect(out);
  osc.start(at);
  osc.stop(at + dur + 0.05);
  return osc;
}

function tick(ctx, out, at, peak = 0.12) {
  const length = Math.floor(ctx.sampleRate * 0.03);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 2200;
  band.Q.value = 3;
  const gain = ctx.createGain();
  gain.gain.value = peak;
  source.connect(band);
  band.connect(gain);
  gain.connect(out);
  source.start(at);
}

const PENTATONIC = [72, 74, 76, 79, 81, 84, 86, 88];

const SYNTH = {
  // Tiles filling: a scatter of bright, quick notes.
  board_fill(ctx, out, t) {
    for (let i = 0; i < 18; i += 1) {
      tone(ctx, out, {
        at: t + i * 0.065,
        freq: note(PENTATONIC[(i * 5) % PENTATONIC.length]),
        dur: 0.18,
        type: 'triangle',
        peak: 0.12,
        release: 0.15,
      });
    }
  },
  category(ctx, out, t) {
    tone(ctx, out, { at: t, freq: note(76), dur: 0.7, type: 'sine', peak: 0.18, release: 0.6 });
    tone(ctx, out, { at: t, freq: note(83), dur: 0.7, type: 'sine', peak: 0.08, release: 0.6 });
  },
  // A rising sweep into a bright chord.
  wager_reveal(ctx, out, t) {
    const sweep = ctx.createOscillator();
    const gain = ctx.createGain();
    sweep.type = 'sawtooth';
    sweep.frequency.setValueAtTime(220, t);
    sweep.frequency.exponentialRampToValueAtTime(1760, t + 0.55);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 3000;
    sweep.connect(lp);
    lp.connect(gain);
    gain.connect(out);
    sweep.start(t);
    sweep.stop(t + 0.65);
    for (const midi of [67, 71, 74, 79]) {
      tone(ctx, out, {
        at: t + 0.58,
        freq: note(midi),
        dur: 1.4,
        type: 'sawtooth',
        peak: 0.07,
        release: 1.0,
        filter: 2600,
      });
    }
  },
  time_up(ctx, out, t) {
    tone(ctx, out, {
      at: t,
      freq: note(52),
      dur: 0.32,
      type: 'square',
      peak: 0.12,
      filter: 1200,
      release: 0.05,
    });
    tone(ctx, out, {
      at: t + 0.36,
      freq: note(48),
      dur: 0.5,
      type: 'square',
      peak: 0.12,
      filter: 1200,
      release: 0.1,
    });
  },
  round_end(ctx, out, t) {
    [79, 76, 72, 67, 64].forEach((midi, i) =>
      tone(ctx, out, {
        at: t + i * 0.14,
        freq: note(midi),
        dur: 0.5,
        type: 'triangle',
        peak: 0.16,
        release: 0.35,
      }),
    );
  },
  buzz(ctx, out, t) {
    tone(ctx, out, { at: t, freq: note(84), dur: 0.09, type: 'sine', peak: 0.12, release: 0.06 });
  },
  game_over(ctx, out, t) {
    [60, 64, 67, 72, 76, 79, 84].forEach((midi, i) =>
      tone(ctx, out, {
        at: t + i * 0.09,
        freq: note(midi),
        dur: 1.6 - i * 0.1,
        type: 'triangle',
        peak: 0.1,
        release: 0.9,
      }),
    );
  },
  // Thirty seconds of original thinking music: a ticking clock, a plucked
  // bass, and a wandering minor melody, ending on a held chord.
  final_think(ctx, out, t, offset = 0) {
    const beat = 0.6; // 100 bpm
    const beats = 50; // 30 s
    const bass = [45, 52, 45, 52, 41, 48, 41, 48, 43, 50, 43, 50, 40, 47, 40, 47];
    const melody = [
      69,
      72,
      76,
      74,
      72,
      71,
      69,
      64,
      65,
      69,
      72,
      71,
      69,
      67,
      64,
      null,
      69,
      72,
      76,
      77,
      76,
      74,
      72,
      71,
      72,
      74,
      76,
      74,
      72,
      71,
      69,
      null,
      76,
      74,
      72,
      74,
      76,
      79,
      77,
      76,
      74,
      72,
      71,
      72,
      69,
      null,
      null,
      null,
      64,
      69,
    ];
    for (let b = 0; b < beats; b += 1) {
      const at = t + b * beat - offset;
      if (at < t - 0.01) continue;
      tick(ctx, out, at, b % 4 === 0 ? 0.16 : 0.09);
      const low = bass[b % bass.length];
      tone(ctx, out, {
        at,
        freq: note(low),
        dur: beat * 0.9,
        type: 'triangle',
        peak: 0.12,
        release: 0.3,
      });
      const high = melody[b];
      if (high)
        tone(ctx, out, {
          at,
          freq: note(high),
          dur: beat * 0.95,
          type: 'sine',
          peak: 0.13,
          attack: 0.02,
          release: 0.25,
        });
    }
    const end = t + beats * beat - offset;
    if (end > t)
      for (const midi of [57, 60, 64, 69])
        tone(ctx, out, {
          at: end,
          freq: note(midi),
          dur: 1.8,
          type: 'triangle',
          peak: 0.1,
          release: 1.2,
        });
  },
};
