# lk voice host

Realtime voice host on LiveKit. Node handles the room and agent logic; the speech models run as native services.

| Piece | Binary | Port | Role |
|---|---|---|---|
| Paradee 8M TTS | `native/build/paradee_server` (C++, ONNX Runtime) | 8790 | `POST /tts {text, speed}` → WAV 24 kHz |
| Underdog Bark 3.0 Clean STT | `native/bin-vulkan/starling-serve-linux-vulkan` | 8181 | `POST /v1/audio/transcriptions` → `{text}` |
| Voice host | `agent/host.mjs` (Node) | 8800 | joins LiveKit room, transcribes, replies |

## Setup
1. Models go in `models/` (Paradee `config.json` + `paradee/paradee_int8.onnx`, misaki `us_gold.json`/`us_silver.json`, Bark `underdog-bark-3.0-clean-q4pw.gguf`).
2. Prebuilt binaries: ONNX Runtime 1.20.1 into `native/vendor/onnxruntime`, `httplib.h` and `json.hpp` into `native/vendor`, Starling Vulkan into `native/bin-vulkan`, LiveKit server into `native/livekit`.
3. Build the TTS server: `cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build`.
4. `cd agent && npm install`.

## Run
```
./run.sh                      # starts a local LiveKit dev server and all services
LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... ./run.sh   # use an existing server
```

Env for `agent/host.mjs`: `LK_ROOM` (default `lk-voice`), `LK_IDENTITY` (`voice-host`), `LLM_URL` (responder webhook: receives `{text, from}`, returns `{text}`; unset = echo), `PARADEE_URL`, `STT_URL`, `HTTP_PORT` (8800).

Endpoints on the host: `GET /health`, `POST /speak {text}`.

## Known limitations
- Paradee falls back to espeak-ng (unpacked locally under `native/espeak`, no root install) for words missing from the misaki lexicon; pronunciation is approximate.
- Starling uses Vulkan; CUDA build here targets sm_120 only and does not run on this GPU.

## Hooking up ccm (MCP inbox)

`.mcp.json` registers `ccm-inbox` from GitHub via `npx -y github:AnEntrypoint/ccm`. Claude Code launches it per session; it serves the HTTP inbox on `127.0.0.1:7777`.

- **Speech → Claude:** the voice host forwards each heard utterance to `INBOX_URL` (default `http://127.0.0.1:7777/messages`) and waits up to `REPLY_TIMEOUT_MS` (120 s) for a reply. The session receives it as a `notifications/message`, or drains it with `read_messages`.
- **Claude → speech (responder):** the `send_message` tool POSTs `{text, sentAt, source}` to `CCM_WEBHOOK_URL` (`http://127.0.0.1:8800/speak`). `/speak` resolves the pending utterance, so the reply is spoken as that turn's answer; with nothing pending it speaks the text directly.

Start `./run.sh` (services and host) before restarting the Claude session so the inbox and webhook are up.
