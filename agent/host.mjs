// LiveKit voice host (Node). Audio work is delegated to native C++ services:
//   Paradee TTS  (native/build/paradee_server)  POST /tts  -> WAV 24 kHz
//   Underdog STT (starling-serve, parakeet)     POST /v1/audio/transcriptions -> JSON {text}
// Outbound: heard speech goes to the ccm inbox (INBOX_URL) for the MCP session to answer,
//   or to LLM_URL (POST {text} -> {text}) when set. Replies come back via POST /speak.
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
const SILENCE_RMS = 500;   // int16 RMS below this counts as silence
const SILENCE_FRAMES = 25; // 0.5 s of silence ends an utterance
const MIN_UTTERANCE_FRAMES = 10;

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

async function speak(text) {
  if (!source) throw new Error('not connected to a room yet');
  const { samples, rate } = await synthesize(text);
  if (rate !== TTS_RATE) throw new Error(`unexpected TTS rate ${rate}`);
  const per = (TTS_RATE * FRAME_MS) / 1000;
  for (let i = 0; i < samples.length; i += per) {
    const chunk = samples.slice(i, i + per);
    const padded = chunk.length === per ? chunk : Object.assign(new Int16Array(per), chunk);
    await source.captureFrame(new AudioFrame(padded, TTS_RATE, 1, per));
  }
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

// Energy-gated segmentation of one remote track into utterances at 16 kHz.
async function listen(track, identity) {
  const stream = new AudioStream(track, { sampleRate: STT_RATE, numChannels: 1 });
  let buf = [];
  let quiet = 0;
  let busy = false;
  for await (const frame of stream) {
    const data = frame.data;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    if (rms >= SILENCE_RMS) {
      buf.push(new Int16Array(data));
      quiet = 0;
    } else if (buf.length) {
      buf.push(new Int16Array(data));
      quiet++;
    }
    if (buf.length && quiet >= SILENCE_FRAMES && !busy) {
      const utter = buf;
      buf = [];
      quiet = 0;
      if (utter.length < MIN_UTTERANCE_FRAMES) continue;
      busy = true;
      handleUtterance(utter, identity).finally(() => { busy = false; });
    }
  }
}

async function handleUtterance(frames, identity) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const pcm = new Int16Array(total);
  let off = 0;
  for (const f of frames) { pcm.set(f, off); off += f.length; }
  try {
    const heard = (await transcribe(pcm)).trim();
    if (!heard) return;
    console.log(`[${identity}] heard: ${heard}`);
    if (cfg.llm) {
      const reply = (await askBrain(heard, identity)).trim();
      if (reply) await speak(reply);
    } else {
      await forwardToInbox(heard, identity);
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
