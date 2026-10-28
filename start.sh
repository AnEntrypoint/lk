#!/usr/bin/env bash
# Start the voice stack and page server if they are down, then launch Claude Code
# with the ccm-inbox channel flag so inbound speech arrives as live channel events.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"

up() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }

# A stale ccm-inbox from an earlier session holds 7777 and blocks the MCP server.
if up 7777 && ! pgrep -f "ccm-inbox" >/dev/null 2>&1; then
  echo "port 7777 is held by an unknown process; free it first" >&2
  exit 1
fi
for pid in $(pgrep -f "ccm-inbox" 2>/dev/null); do
  [ "$(ps -o ppid= -p "$pid" | tr -d ' ')" = "1" ] && kill "$pid"
done

if ! up 8800; then
  cd "$ROOT" && setsid nohup bash run.sh > /tmp/run.log 2>&1 < /dev/null &
fi
if ! up 8801; then
  cd "$ROOT/agent" && setsid nohup node web-server.mjs > /tmp/web.log 2>&1 < /dev/null &
fi
cd "$ROOT"
echo "starting voice stack (first start can take a minute while models load)..."

for _ in $(seq 1 60); do up 8800 && up 8801 && break; sleep 1; done
up 8800 && up 8801 || { echo "voice stack did not come up; see /tmp/run.log" >&2; exit 1; }
echo "voice stack up; page at http://127.0.0.1:8801 (open with the browser verb)"

exec claude --dangerously-load-development-channels server:ccm-inbox "$@"
