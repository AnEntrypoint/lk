// LiveKit voice host (Node). Audio work is delegated to native C++ services:
//   Paradee TTS  (native/build/paradee_server)  POST /tts  -> WAV 24 kHz
//   Underdog STT (starling-serve, parakeet)     POST /v1/audio/transcriptions -> JSON {text}
// Outbound: heard speech goes to the ccm inbox (INBOX_URL); the session answers via ccm send_message,
//   which posts the reply to POST /speak and the host speaks it. LLM_URL (POST {text} -> {text}) overrides.
// Inbound HTTP:   POST /speak {text} makes the bot say it in the room.
import http from 'node:http';
import { AccessToken } from 'livekit-server-sdk';
import {
  Room,
  RoomEvent,
  AudioSource,
  AudioFrame,
  AudioStream,
  LocalAudioTrack,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

const env = process.env;
const cfg = {
  url: env.LIVEKIT_URL,
  key: env.LIVEKIT_API_KEY,
  secret: env.LIVEKIT_API_SECRET,
  room: env.LK_ROOM ?? 'lk-voice',
  identity: env.LK_IDENTITY ?? 'voice-host',
  paradee: env.PARADEE_URL ?? 'http://127.0.0.1:8790',
  stt: env.STT_URL ?? 'http://127.0.0.1:8181/v1/audio/transcriptions',
  llm: env.LLM_URL ?? '',
  inbox: env.INBOX_URL ?? 'http://127.0.0.1:7777/messages',
  port: Number(env.HTTP_PORT ?? 8800),
};

const TTS_RATE = 24000;
const STT_RATE = 16000;
const FRAME_MS = 20;
const CAPTURE_RATE = 48000;
const CAPTURE_FRAME_MS = 10;            // small capture frames keep latency low
const DECIMATE = CAPTURE_RATE / STT_RATE;
const ENERGY_DBFS = Number(env.ENERGY_DBFS ?? -40);            // raw level that starts an utterance
const ENERGY_CONTINUE_DBFS = Number(env.ENERGY_CONTINUE_DBFS ?? -46); // hysteresis: stay in speech through dips
const BARGE_DBFS = Number(env.BARGE_DBFS ?? -30);              // raw level that counts as barge-in during playback
const BARGE_FRAMES = Number(env.BARGE_MS ?? 250) / CAPTURE_FRAME_MS;
const END_SILENCE_FRAMES = Number(env.END_SILENCE_MS ?? 800) / CAPTURE_FRAME_MS;
const PRE_ROLL_FRAMES = 20;             // 200 ms kept before speech onset
const MIN_UTTERANCE_FRAMES = 10;        // 100 ms
const REPLY_TIMEOUT_MS = Number(env.REPLY_TIMEOUT_MS ?? 120000);

function token() {
  const at = new AccessToken(cfg.key, cfg.secret, { identity: cfg.identity });
  at.addGrant({ roomJoin: true, room: cfg.room, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

// Minimal WAV reader: PCM16 mono, returns Int16Array and sample rate.
function readWav(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rate = view.getUint32(24, true);
  let off = 12;
  while (off < buf.byteLength - 8) {
    const id = String.fromCharCode(...buf.subarray(off, off + 4));
    const size = view.getUint32(off + 4, true);
    if (id === 'data') {
      return { samples: new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size)), rate };
    }
    off += 8 + size;
  }
  throw new Error('no data chunk in WAV');
}

function wavFromPcm16(samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function synthesize(text) {
  const res = await fetch(`${cfg.paradee}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, speed: 1.0 }),
  });
  if (!res.ok) throw new Error(`paradee ${res.status}: ${await res.text()}`);
  return readWav(new Uint8Array(await res.arrayBuffer()));
}

let source;
// Mic audio is ignored while the bot speaks and for ECHO_TAIL_MS after, so the
// room's own playback picked up by a browser mic is not transcribed back.
const ECHO_TAIL_MS = 800;
let speakingUntil = 0;
let playbackId = 0;
       // same as the speech-start threshold; BARGE_MS guards against blips

// Cancels whatever the bot is saying: drops queued audio and stops the speak loop.
function interruptPlayback() {
  playbackId++;
  speakingUntil = 0;
  source?.clearQueue();
}

// Sentence-sized pieces so the first words play while the rest is still synthesizing.
function splitSentences(text) {
  const parts = text.match(/[^.!?]+[.!?]*/g) ?? [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

async function synthesizeChecked(text) {
  const { samples, rate } = await synthesize(text);
  if (rate !== TTS_RATE) throw new Error(`unexpected TTS rate ${rate}`);
  return samples;
}

async function speak(text) {
  if (!source) throw new Error('not connected to a room yet');
  const id = ++playbackId;
  const per = (TTS_RATE * FRAME_MS) / 1000;
  const sentences = splitSentences(text);
  if (!sentences.length) return;
  let pending = synthesizeChecked(sentences[0]);
  for (let s = 0; s < sentences.length; s++) {
    const samples = await pending;
    if (s + 1 < sentences.length) {
      pending = synthesizeChecked(sentences[s + 1]);
      pending.catch(() => {});
    }
    if (id !== playbackId) return;
    speakingUntil = Math.max(speakingUntil, Date.now()) + (samples.length / TTS_RATE) * 1000;
    for (let i = 0; i < samples.length; i += per) {
      if (id !== playbackId) return;
      const chunk = samples.slice(i, i + per);
      const padded = chunk.length === per ? chunk : Object.assign(new Int16Array(per), chunk);
      await source.captureFrame(new AudioFrame(padded, TTS_RATE, 1, per));
    }
  }
  if (id === playbackId) speakingUntil = Date.now() + ECHO_TAIL_MS;
}

async function transcribe(samples16k) {
  const wav = wavFromPcm16(samples16k, STT_RATE);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', 'parakeet');
  const res = await fetch(cfg.stt, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`stt ${res.status}: ${await res.text()}`);
  return (await res.json()).text ?? '';
}

async function forwardToInbox(text, from) {
  const res = await fetch(cfg.inbox, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from, text }),
  });
  if (!res.ok) throw new Error(`inbox ${res.status}`);
}

// Replies that arrive on POST /speak while an utterance is waiting resolve that wait
// (FIFO). Used for the MCP round trip: inbox forward -> session send_message -> /speak.
const waiters = [];
function awaitReply() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      resolve('');
    }, REPLY_TIMEOUT_MS);
    const done = (text) => { clearTimeout(timer); resolve(text); };
    waiters.push(done);
  });
}

async function askBrain(text, from) {
  if (!cfg.llm) return `You said: ${text}`;
  const res = await fetch(cfg.llm, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, from }),
  });
  if (!res.ok) throw new Error(`llm ${res.status}`);
  return (await res.json()).text ?? '';
}

// Raw-path endpointing: no denoise, gain or gate stage. Each 10 ms frame is decimated to
// 16 kHz for STT and classified by its own level. Hysteresis keeps dips inside a sentence.
// Windowed-sinc low-pass (cutoff 7.2 kHz at 48 kHz, Hann window, 96 taps) so energy above
// 8 kHz cannot fold back into the speech band when decimating by 3.
const LP_TAPS = 96;
const LP_TAPS_ARR = (() => {
  const fc = 7200 / CAPTURE_RATE;
  const taps = new Float64Array(LP_TAPS);
  let sum = 0;
  for (let n = 0; n < LP_TAPS; n++) {
    const m = n - (LP_TAPS - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    taps[n] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (LP_TAPS - 1)));
    sum += taps[n];
  }
  for (let n = 0; n < LP_TAPS; n++) taps[n] /= sum;
  return taps;
})();
function makeDecimator() {
  const lpHistory = new Float64Array(LP_TAPS);
  let lpPos = 0;
  return (pcm48) => decimateWith(pcm48, lpHistory, () => lpPos, (v) => { lpPos = v; });
}

function decimateWith(pcm48, lpHistory, getPos, setPos) {
  let lpPos = getPos();
  const out = new Int16Array(pcm48.length / DECIMATE);
  let o = 0;
  for (let i = 0; i < pcm48.length; i++) {
    lpHistory[lpPos] = pcm48[i];
    if (i % DECIMATE === DECIMATE - 1) {
      let acc = 0;
      for (let k = 0; k < LP_TAPS; k++) acc += LP_TAPS_ARR[k] * lpHistory[(lpPos - k + LP_TAPS) % LP_TAPS];
      out[o++] = Math.max(-32768, Math.min(32767, Math.round(acc)));
    }
    lpPos = (lpPos + 1) % LP_TAPS;
  }
  setPos(lpPos);
  return out;
}

function rawDbfs(pcm48) {
  let sum = 0;
  for (let i = 0; i < pcm48.length; i++) sum += pcm48[i] * pcm48[i];
  const rms = Math.sqrt(sum / pcm48.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

async function listen(track, identity) {
  const stream = new AudioStream(track, { sampleRate: CAPTURE_RATE, numChannels: 1, frameSizeMs: CAPTURE_FRAME_MS });
  const decimateTo16k = makeDecimator();
  const preRoll = [];
  let utter = null;
  let silent = 0;
  let bargeCount = 0;
  let peakDb = -Infinity;
  let lastLog = 0;
  for await (const frame of stream) {
    const pcm16k = decimateTo16k(frame.data);
    const db = rawDbfs(frame.data);
    if (Date.now() < speakingUntil) {
      const now = Date.now();
      if (now - lastLog >= 1000) {
        console.log(`[${identity}] during playback: peakDbfs=${peakDb.toFixed(1)}`);
        peakDb = -Infinity;
        lastLog = now;
      }
      peakDb = Math.max(peakDb, db);
      bargeCount = db >= BARGE_DBFS ? bargeCount + 1 : 0;
      if (bargeCount < BARGE_FRAMES) {
        preRoll.push(pcm16k);
        if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
        continue;
      }
      bargeCount = 0;
      interruptPlayback();
      console.log(`[${identity}] barge-in: playback interrupted`);
    }
    if (utter) {
      utter.push(pcm16k);
      silent = db >= ENERGY_CONTINUE_DBFS ? 0 : silent + 1;
      if (silent >= END_SILENCE_FRAMES) {
        const done = utter;
        utter = null;
        if (done.length >= MIN_UTTERANCE_FRAMES) handleUtterance(done, identity);
      }
    } else if (db >= ENERGY_DBFS) {
      utter = [...preRoll, pcm16k];
      silent = 0;
    }
    preRoll.push(pcm16k);
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
  }
}

// Transcriptions run one at a time so utterances are served in order without blocking capture.
let sttChain = Promise.resolve();
function transcribeQueued(pcm) {
  const job = sttChain.then(() => transcribe(pcm));
  sttChain = job.catch(() => {});
  return job;
}

async function handleUtterance(frames, identity) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const f of frames) { pcm.set(f, off); off += f.length; }
  try {
    const heard = (await transcribeQueued(pcm)).trim();
    if (!heard) return;
    console.log(`[${identity}] heard: ${heard}`);
    if (cfg.llm) {
      const reply = (await askBrain(heard, identity)).trim();
      if (reply) await speak(reply);
    } else {
      await forwardToInbox(heard, identity);
      const reply = (await awaitReply()).trim();
      if (!reply) console.log(`[${identity}] no reply within ${REPLY_TIMEOUT_MS} ms`);
      else { console.log(`[${identity}] reply: ${reply}`); await speak(reply); }
    }
  } catch (err) {
    console.error('utterance failed:', err.message);
  }
}

async function main() {
  if (!cfg.url || !cfg.key || !cfg.secret) throw new Error('set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');

  const room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === TrackKind.KIND_AUDIO && participant.identity !== cfg.identity) listen(track, participant.identity);
  });
  await room.connect(cfg.url, await token(), { autoSubscribe: true });
  console.log(`joined ${cfg.room} as ${cfg.identity}`);

  source = new AudioSource(TTS_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('voice-host', source);
  await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));

  http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.method === 'POST' && req.url === '/speak') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text) { res.statusCode = 400; return res.end('{"error":"text required"}'); }
        if (waiters.length) {
          console.log(`reply resolved pending utterance: ${text}`);
          waiters.shift()(text);
          return res.end('{"ok":true,"reply":true}');
        }
        console.log(`speak (no pending utterance): ${text}`);
        await speak(text);
        return res.end('{"ok":true}');
      } catch (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: err.message }));
      }
    }
    res.statusCode = 404;
    res.end();
  }).listen(cfg.port, '127.0.0.1', () => console.log(`http on 127.0.0.1:${cfg.port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
