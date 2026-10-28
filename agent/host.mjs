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
import createRNN from './vendor/rnnoise-sync.mjs';

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
const RNN_FRAME = CAPTURE_RATE * CAPTURE_FRAME_MS / 1000; // rnnoise runs on 10 ms at 48 kHz
const DECIMATE = CAPTURE_RATE / STT_RATE;
const VAD_THRESHOLD = Number(env.VAD_THRESHOLD ?? 0.6);
const GATE_DBFS = Number(env.GATE_DBFS ?? -16);  // frames quieter than this never count as speech
const DRC_WINDOW_FRAMES = 60000 / CAPTURE_FRAME_MS; // 60 s moving window of 10 ms frames
const DRC_TARGET_DBFS = Number(env.DRC_TARGET_DBFS ?? -20);
const DRC_MAX_BOOST = Number(env.DRC_MAX_BOOST ?? 2); // linear gain ceiling: 2x = +6 dB
const END_SILENCE_FRAMES = Number(env.END_SILENCE_MS ?? 300) / CAPTURE_FRAME_MS;
const MAX_UTTER_FRAMES = Number(env.MAX_UTTER_MS ?? 6000) / CAPTURE_FRAME_MS;
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

async function speak(text) {
  if (!source) throw new Error('not connected to a room yet');
  const { samples, rate } = await synthesize(text);
  if (rate !== TTS_RATE) throw new Error(`unexpected TTS rate ${rate}`);
  const per = (TTS_RATE * FRAME_MS) / 1000;
  speakingUntil = Date.now() + (samples.length / TTS_RATE) * 1000 + ECHO_TAIL_MS;
  for (let i = 0; i < samples.length; i += per) {
    const chunk = samples.slice(i, i + per);
    const padded = chunk.length === per ? chunk : Object.assign(new Int16Array(per), chunk);
    await source.captureFrame(new AudioFrame(padded, TTS_RATE, 1, per));
  }
  speakingUntil = Date.now() + ECHO_TAIL_MS;
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

// rnnoise denoises each 10 ms frame at 48 kHz, returns its voice-activity probability,
// and the output is decimated to 16 kHz for STT.
const rnn = await createRNN();
const rnnIn = rnn._malloc(RNN_FRAME * 4);
const rnnOut = rnn._malloc(RNN_FRAME * 4);

function denoiseFrame(state, pcm48) {
  const base = rnnIn >> 2;
  for (let i = 0; i < RNN_FRAME; i++) rnn.HEAPF32[base + i] = pcm48[i];
  const vad = rnn._rnnoise_process_frame(state, rnnOut, rnnIn);
  const outBase = rnnOut >> 2;
  const pcm16k = new Int16Array(RNN_FRAME / DECIMATE);
  for (let i = 0; i < pcm16k.length; i++) {
    const j = outBase + i * DECIMATE;
    let sum = 0;
    for (let k = 0; k < DECIMATE; k++) sum += rnn.HEAPF32[j + k];
    pcm16k[i] = Math.max(-32768, Math.min(32767, Math.round(sum / DECIMATE)));
  }
  return { vad, pcm16k };
}

// Moving-window leveler: tracks mean power over the last 60 s and boosts quiet input toward
// DRC_TARGET_DBFS, capped at DRC_MAX_BOOST. Gain is smoothed so it does not pump.
function makeLeveler() {
  const power = new Float64Array(DRC_WINDOW_FRAMES);
  let idx = 0;
  let filled = 0;
  let sum = 0;
  let gain = 1;
  const maxGain = DRC_MAX_BOOST;
  return (pcm) => {
    let p = 0;
    for (let i = 0; i < pcm.length; i++) p += (pcm[i] / 32768) ** 2;
    p /= pcm.length;
    sum += p - power[idx];
    power[idx] = p;
    idx = (idx + 1) % DRC_WINDOW_FRAMES;
    if (filled < DRC_WINDOW_FRAMES) filled++;
    const meanDb = sum > 0 ? 10 * Math.log10(sum / filled) : -120;
    const want = Math.min(maxGain, 10 ** ((DRC_TARGET_DBFS - meanDb) / 20));
    gain += (Math.max(1, want) - gain) * 0.05;
    const out = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i] * gain)));
    return out;
  };
}

function frameDbfs(pcm16k) {
  let sum = 0;
  for (let i = 0; i < pcm16k.length; i++) sum += pcm16k[i] * pcm16k[i];
  const rms = Math.sqrt(sum / pcm16k.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// VAD-endpointed segmentation of one remote track. An utterance is sent as soon as
// speech has been quiet for END_SILENCE_MS, or when it reaches MAX_UTTER_MS.
async function listen(track, identity) {
  const stream = new AudioStream(track, { sampleRate: CAPTURE_RATE, numChannels: 1, frameSizeMs: CAPTURE_FRAME_MS });
  const state = rnn._rnnoise_create(0);
  const level = makeLeveler();
  const preRoll = [];
  let utter = null;
  let silent = 0;
  for await (const frame of stream) {
    if (Date.now() < speakingUntil) { preRoll.length = 0; utter = null; continue; }
    const { vad, pcm16k: denoised } = denoiseFrame(state, frame.data);
    const pcm16k = level(denoised);
    const voiced = vad >= VAD_THRESHOLD && frameDbfs(pcm16k) >= GATE_DBFS;
    if (utter) {
      utter.push(pcm16k);
      silent = voiced ? 0 : silent + 1;
      if (silent >= END_SILENCE_FRAMES || utter.length >= MAX_UTTER_FRAMES) {
        const done = utter;
        utter = null;
        if (done.length >= MIN_UTTERANCE_FRAMES) handleUtterance(done, identity);
      }
    } else if (voiced) {
      utter = [...preRoll, pcm16k];
      silent = 0;
    }
    preRoll.push(pcm16k);
    if (preRoll.length > PRE_ROLL_FRAMES) preRoll.shift();
  }
  rnn._rnnoise_destroy(state);
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
