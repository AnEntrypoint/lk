// Joins the room as a test speaker, streams a Paradee utterance in real time, then leaves.
import { AccessToken } from 'livekit-server-sdk';
import { Room, AudioSource, AudioFrame, LocalAudioTrack, TrackPublishOptions, TrackSource } from '@livekit/rtc-node';

const text = process.argv[2] ?? 'What is the weather like today?';
const at = new AccessToken('devkey', 'secret', { identity: 'tester' });
at.addGrant({ roomJoin: true, room: 'lk-voice', canPublish: true, canSubscribe: true });

const res = await fetch('http://127.0.0.1:8790/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, speed: 1.0 }) });
const wav = new Uint8Array(await res.arrayBuffer());
const view = new DataView(wav.buffer);
let off = 12; let data;
while (off < wav.byteLength - 8) {
  const id = String.fromCharCode(...wav.subarray(off, off + 4));
  const size = view.getUint32(off + 4, true);
  if (id === 'data') { data = new Int16Array(wav.buffer.slice(wav.byteOffset + off + 8, wav.byteOffset + off + 8 + size)); break; }
  off += 8 + size;
}

const room = new Room();
await room.connect('ws://127.0.0.1:7880', await at.toJwt(), { autoSubscribe: true });
const source = new AudioSource(24000, 1);
const track = LocalAudioTrack.createAudioTrack('tester-mic', source);
await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
const per = 480;
for (let i = 0; i < data.length; i += per) {
  const chunk = data.slice(i, i + per);
  const padded = chunk.length === per ? chunk : Object.assign(new Int16Array(per), chunk);
  await source.captureFrame(new AudioFrame(padded, 24000, 1, per));
}
// trailing silence so the host's end-of-utterance detector fires
for (let i = 0; i < 40; i++) await source.captureFrame(new AudioFrame(new Int16Array(per), 24000, 1, per));
console.log(`sent ${(data.length / 24000).toFixed(2)}s utterance`);
await new Promise((r) => setTimeout(r, 8000));
await room.disconnect();
