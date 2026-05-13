#!/usr/bin/env bash
# mini-load-test.sh — 10-minute stability + speed test
#
# Usage:
#   BASE=https://litellm-agent-platform.onrender.com \
#   KEY=sk-... \
#   AGENT_ID=214ec20b-4213-485a-a499-a206881b1891 \
#   bash scripts/mini-load-test.sh
#
# Or set BASE/KEY/AGENT_ID in .env and source it first.

set -euo pipefail

BASE="${BASE:?set BASE to the platform URL}"
KEY="${KEY:?set KEY to MASTER_KEY}"
AGENT_ID="${AGENT_ID:?set AGENT_ID}"

RED='\033[0;31m' GRN='\033[0;32m' YLW='\033[0;33m' DIM='\033[2m' RST='\033[0m'
log()  { echo -e "$(date -u +%H:%M:%S)  $*"; }
ok()   { echo -e "$(date -u +%H:%M:%S)  ${GRN}✓ $*${RST}"; }
fail() { echo -e "$(date -u +%H:%M:%S)  ${RED}✗ $*${RST}"; }
warn() { echo -e "$(date -u +%H:%M:%S)  ${YLW}! $*${RST}"; }

# ── Pre-flight: K8s health ──────────────────────────────────────────────────

log "Pre-flight: checking K8s health..."
HEALTH_CODE=$(curl -s -o /tmp/k8s_health_resp.json -w "%{http_code}" \
  -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/health/k8s" 2>/dev/null || echo "000")
HEALTH_BODY=$(cat /tmp/k8s_health_resp.json 2>/dev/null || echo "{}")

if [ "$HEALTH_CODE" = "200" ]; then
  ok "K8s reachable (HTTP 200)"
elif [ "$HEALTH_CODE" = "404" ]; then
  warn "Health endpoint not deployed yet — skipping pre-flight, K8s state unknown"
elif [ "$HEALTH_CODE" = "503" ]; then
  HEALTH_ERR=$(echo "$HEALTH_BODY" | python3 -c "import json,sys; print(json.load(sys.stdin).get('error','unknown'))" 2>/dev/null || echo "$HEALTH_BODY")
  fail "K8s unhealthy — aborting. Error: $HEALTH_ERR"
  echo ""
  echo "Fix AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in Render, redeploy, then retry."
  exit 1
else
  warn "Health check returned HTTP $HEALTH_CODE — continuing anyway"
fi
echo ""

# ── Counters ────────────────────────────────────────────────────────────────

TOTAL=0; N_OK=0; N_FAIL=0; N_TIMEOUT=0; N_WARM=0; N_COLD=0
SUM_WARM=0; SUM_COLD=0; MAX_WARM=0; MAX_COLD=0

# ── Session create + wait helper ────────────────────────────────────────────

create_and_wait() {
  local label="$1"
  local START_MS
  START_MS=$(python3 -c "import time; print(int(time.time()*1000))")

  # Create session
  local RESP
  RESP=$(curl -sf \
    -H "Authorization: Bearer $KEY" \
    -H "content-type: application/json" \
    -d '{"title":"mini-load-test"}' \
    "$BASE/api/v1/managed_agents/agents/$AGENT_ID/session" 2>/dev/null || echo "")

  if [ -z "$RESP" ]; then
    fail "[$label] create request failed (curl error)"
    N_FAIL=$((N_FAIL+1)); TOTAL=$((TOTAL+1)); return
  fi

  local SID
  SID=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || echo "")

  if [ -z "$SID" ]; then
    fail "[$label] no session_id in response: $RESP"
    N_FAIL=$((N_FAIL+1)); TOTAL=$((TOTAL+1)); return
  fi

  # Poll until ready/failed, max 90s
  local STATUS="" FAILURE_REASON="" SPAWN_MODE=""
  for _ in $(seq 1 90); do
    local ROW
    ROW=$(curl -sf \
      -H "Authorization: Bearer $KEY" \
      "$BASE/api/v1/managed_agents/sessions/$SID" 2>/dev/null || echo "")

    STATUS=$(echo "$ROW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "")
    SPAWN_MODE=$(echo "$ROW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('spawn_mode') or '')" 2>/dev/null || echo "")

    if [ "$STATUS" = "ready" ]; then break; fi
    if [ "$STATUS" = "failed" ]; then
      FAILURE_REASON=$(echo "$ROW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('failure_reason') or '')" 2>/dev/null || echo "")
      break
    fi
    sleep 1
  done

  local END_MS LAT_MS
  END_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  LAT_MS=$((END_MS - START_MS))

  TOTAL=$((TOTAL+1))

  if [ "$STATUS" = "ready" ]; then
    N_OK=$((N_OK+1))
    # Determine mode from logs (spawn_mode field may not exist yet; use latency heuristic)
    if [ -n "$SPAWN_MODE" ]; then
      local MODE="$SPAWN_MODE"
    elif [ "$LAT_MS" -lt 3000 ]; then
      local MODE="warm"
    else
      local MODE="cold"
    fi
    if [ "$MODE" = "warm" ]; then
      N_WARM=$((N_WARM+1)); SUM_WARM=$((SUM_WARM+LAT_MS))
      [ "$LAT_MS" -gt "$MAX_WARM" ] && MAX_WARM=$LAT_MS
    else
      N_COLD=$((N_COLD+1)); SUM_COLD=$((SUM_COLD+LAT_MS))
      [ "$LAT_MS" -gt "$MAX_COLD" ] && MAX_COLD=$LAT_MS
    fi
    ok "[$label] ready  sid=${SID:0:8} ${LAT_MS}ms mode=${MODE}"
  elif [ "$STATUS" = "failed" ]; then
    N_FAIL=$((N_FAIL+1))
    fail "[$label] failed sid=${SID:0:8} ${LAT_MS}ms reason=${FAILURE_REASON:0:80}"
  else
    N_TIMEOUT=$((N_TIMEOUT+1))
    warn "[$label] timeout sid=${SID:0:8} last_status=$STATUS after 90s"
  fi
}

# ── Test schedule (10 minutes) ───────────────────────────────────────────────
#
# Minute 0-2:  1 req/min  — baseline, pool should hit warm
# Minute 2-4:  5 req/min  — light burst, pool may exhaust → cold fallback
# Minute 4-6:  10 req/min — heavy burst (1 req every 6s)
# Minute 6-8:  1 req/min  — recovery: pool should replenish within 2 ticks
# Minute 8-10: 3 req/min  — final check: pool back? latency back to warm?

echo "═══════════════════════════════════════════════════"
echo " Mini Load Test — 10 minutes"
echo " Agent: $AGENT_ID"
echo " Target: warm p99 < 1000ms, success rate > 95%"
echo "═══════════════════════════════════════════════════"
echo ""

run_phase() {
  local phase_name="$1" count="$2" interval_s="$3"
  log "${DIM}── $phase_name (${count} reqs, every ${interval_s}s) ──${RST}"
  for i in $(seq 1 "$count"); do
    create_and_wait "$phase_name #$i" &
    sleep "$interval_s"
  done
  wait  # wait for all background creates in this phase
  echo ""
}

run_phase "baseline"     2  60   # 1/min × 2 min
run_phase "light-burst"  10 12   # 5/min × 2 min
run_phase "heavy-burst"  20 6    # 10/min × 2 min
run_phase "recovery"     2  60   # 1/min × 2 min
run_phase "final-check"  6  20   # 3/min × 2 min

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo " RESULTS"
echo "═══════════════════════════════════════════════════"
echo " Total:    $TOTAL"
echo -e " Success:  ${GRN}$N_OK${RST}"
echo -e " Failed:   ${RED}$N_FAIL${RST}"
echo -e " Timeout:  ${YLW}$N_TIMEOUT${RST}"
SUCCESS_RATE=0
[ "$TOTAL" -gt 0 ] && SUCCESS_RATE=$(python3 -c "print(f'{$N_OK/$TOTAL*100:.1f}')")
echo " Success%: $SUCCESS_RATE%"
echo ""
echo " Warm hits: $N_WARM"
if [ "$N_WARM" -gt 0 ]; then
  AVG_WARM=$(python3 -c "print($SUM_WARM // $N_WARM)")
  echo " Warm avg: ${AVG_WARM}ms  max: ${MAX_WARM}ms"
  [ "$MAX_WARM" -lt 1000 ] && echo -e " ${GRN}✓ warm p99 < 1s target MET${RST}" || echo -e " ${RED}✗ warm p99 < 1s target MISSED${RST}"
fi
echo ""
echo " Cold hits: $N_COLD"
if [ "$N_COLD" -gt 0 ]; then
  AVG_COLD=$(python3 -c "print($SUM_COLD // $N_COLD)")
  echo " Cold avg: ${AVG_COLD}ms  max: ${MAX_COLD}ms"
fi
echo ""

# Pass/fail
PASSED=true
[ "$TOTAL" -eq 0 ] && { echo -e "${RED}FAIL: no sessions attempted (script error?)${RST}"; PASSED=false; }
[ "$TOTAL" -gt 0 ] && [ "$N_OK" -lt "$((TOTAL * 95 / 100))" ] && { echo -e "${RED}FAIL: success rate below 95%${RST}"; PASSED=false; }
[ "$N_WARM" -gt 0 ] && [ "$MAX_WARM" -gt 1000 ] && { echo -e "${RED}FAIL: warm max latency ${MAX_WARM}ms exceeds 1000ms${RST}"; PASSED=false; }
[ "$PASSED" = true ] && echo -e "${GRN}PASS${RST}" || echo -e "${RED}FAIL — see above${RST}"
echo "═══════════════════════════════════════════════════"
