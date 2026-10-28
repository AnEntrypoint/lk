// Browser side of the voice loop: publishes the mic (receiver path) and plays the host's track (responder path).
import { Room, RoomEvent, Track } from 'https://esm.sh/livekit-client@2';

const $ = (id) => document.getElementById(id);
const setStatus = (s) => { $('status').textContent = s; };
let room;

async function join() {
  $('join').disabled = true;
  setStatus('connecting');
  const identity = `browser-${Math.random().toString(36).slice(2, 7)}`;
  const { url, token } = await (await fetch(`/token?identity=${identity}`)).json();
  room = new Room();
  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.dataset.from = participant.identity;
    $('audio').appendChild(el);
    setStatus(`hearing ${participant.identity}`);
  });
  room.on(RoomEvent.Disconnected, () => { setStatus('disconnected'); $('join').disabled = false; $('leave').disabled = true; });
  await room.connect(url, token);
  await room.localParticipant.setMicrophoneEnabled(true);
  $('leave').disabled = false;
  setStatus(`connected as ${identity}`);
}

async function leave() {
  await room?.disconnect();
  $('audio').replaceChildren();
}

$('join').onclick = () => join().catch((err) => { setStatus(`error: ${err.message}`); $('join').disabled = false; });
$('leave').onclick = leave;
if (new URLSearchParams(location.search).has('autojoin')) join().catch((err) => setStatus(`error: ${err.message}`));
