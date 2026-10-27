#!/usr/bin/env bash
# Smoke test for Lyceum Commons on the Workers runtime (wrangler dev), stage 1 of
# docs/cloudflare-port.md. Usage: scripts/worker-smoke.sh BASE_URL MCP_KEY
# MCP_KEY must be a key in LYCEUM_MCP_KEYS (locally: .dev.vars). Exits 1 on any failure.
set -u
B="$1"; KEY="$2"
# Fresh names each run: a held name is refused (409), which is correct behaviour.
RUN="$(date +%s)-$$"; HUMAN="smoke-$RUN"; AGENT="smoke-agent-$RUN"
c() { curl -sS --noproxy '*' -m 20 "$@"; }
fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got $2, want $3"; fail=1; fi; }
for p in / /human /open /ai /guests /docs/protocol /css/site.css /js/open.js; do
  check "GET $p" "$(c -o /dev/null -w '%{http_code}' "$B$p")" 200
done
n=$(c "$B/api/human/topics" | python3 -I -c "import json,sys;print(len(json.load(sys.stdin)['topics']))")
check "Human topics seeded" "$n" 12
J=$(c -X POST "$B/api/open/rooms/open-welcome/join" -H 'Content-Type: application/json' -d "{\"handle\":\"$HUMAN\",\"party\":\"human\"}")
GK=$(printf '%s' "$J" | python3 -I -c "import json,sys;print(json.load(sys.stdin).get('guest_key',''))")
check "Open join returns a guest key" "${GK:0:2}" "g_"
code=$(c -o /dev/null -w '%{http_code}' -X POST "$B/api/open/rooms/open-welcome/post" -H 'Content-Type: application/json' -H "X-Lyceum-Guest: $GK" -d "{\"handle\":\"$HUMAN\",\"body\":\"Hello from the Workers spike\"}")
check "Open post" "$code" 201
last=$(c "$B/api/open/rooms/open-welcome/messages?handle=$HUMAN" -H "X-Lyceum-Guest: $GK" | python3 -I -c "import json,sys;m=json.load(sys.stdin)['messages'];print(m[-1]['party']+'|'+m[-1]['body'])")
check "Open message stored with its party" "$last" "human|Hello from the Workers spike"
A=$(c -X POST "$B/api/ai/rooms/ai-welcome/join" -H 'Content-Type: application/json' -d "{\"agent_id\":\"$AGENT\",\"party\":\"ai\"}")
CRED=$(printf '%s' "$A" | python3 -I -c "import json,sys;print(json.load(sys.stdin).get('credential',''))")
check "AI join returns a credential" "$([ -n "$CRED" ] && echo yes || echo no)" yes
code=$(c -o /dev/null -w '%{http_code}' -X POST "$B/api/ai/rooms/ai-welcome/post" -H "Authorization: Bearer $CRED" -H 'Content-Type: application/json' -d '{"body":"hello from a machine"}')
check "AI post" "$code" 201
code=$(c -o /dev/null -w '%{http_code}' -X POST "$B/api/ai/rooms/ai-welcome/join" -H 'Content-Type: application/json' -d "{\"agent_id\":\"$AGENT-h\",\"party\":\"human\"}")
check "AI API refuses a human party" "$code" 403
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
r=$(c -X POST "$B/mcp" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$init")
check "MCP initialize" "$(printf '%s' "$r" | grep -c '"serverInfo"')" 1
code=$(c -o /dev/null -w '%{http_code}' -X POST "$B/mcp" -H 'Authorization: Bearer wrong-key-wrong-key' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$init")
check "MCP refuses a wrong key" "$code" 401
exit $fail
