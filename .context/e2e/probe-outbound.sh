#!/usr/bin/env bash
set -euo pipefail

# School outbound cache-warming probe
# Usage: ./probe-outbound.sh [--once|--loop]
#   --once: single probe, print results, exit
#   --loop: probe every INTERVAL seconds (default 7200 = 2h)

LOG=".context/e2e/cache-warming-log.md"
INTERVAL="${PROBE_INTERVAL:-7200}"

SCHOOLS=("001073:IN:Butler" "001816:IN:IvyTech" "001825:IN:NotreDame")
TOTAL_COURSES=2076

RED_FLAG=0

probe() {
  local ts
  ts=$(date -u +"%Y-%m-%d %H:%M UTC")

  echo ""
  echo "=== Probe at ${ts} ==="

  local row="| $(printf '%s' "$ts" | sed 's/.*\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\} [0-9]\{2\}:[0-9]\{2\}\).*/\1/') |"

  for s in "${SCHOOLS[@]}"; do
    IFS=':' read -r id st nm <<< "$s"

    local tmpjson="/tmp/outbound-${id}.json"
    local tmphdr="/tmp/outbound-${id}.hdr"

    total=$(curl -w '%{time_total}' -o "$tmpjson" -s -D "$tmphdr" --max-time 180 \
      "https://boilercredits.xyz/api/meta/school-outbound-equivalencies?schoolId=${id}&state=${st}&location=US") || {
      echo "  RED FLAG: ${nm} HTTP error (curl exit $?)"
      row+=" ERR |"
      RED_FLAG=1
      continue
    }

    layer=$(grep -i '^x-cache-layer' "$tmphdr" 2>/dev/null | awk '{print $2}' | tr -d '\r' || echo "unknown")
    missing=$(grep -oE '"coursesMissingCache":[0-9]+' "$tmpjson" | head -1 | cut -d: -f2)
    withC=$(grep -oE '"coursesWithCache":[0-9]+' "$tmpjson" | head -1 | cut -d: -f2)

    local secs
    secs=$(printf '%.1f' "$total")
    echo "  ${nm}: ${secs}s layer=${layer:-?} with=${withC:-?} missing=${missing:-?}"

    row+=" ${secs}s ${layer:-?} |"

    # Red flag checks
    if printf '%s' "$tmphdr" | grep -q 'HTTP/[0-9.]* 5'; then
      echo "  RED FLAG: ${nm} returned HTTP 5xx"
      RED_FLAG=1
    fi
  done

  # Use the last school's with/missing (they're all the same global counter)
  local pct=0
  if [ -n "${withC:-}" ] && [ "$withC" -gt 0 ]; then
    pct=$((withC * 100 / TOTAL_COURSES))
  fi
  row+=" ${withC:-?} (${pct}%) | ${missing:-?} | "

  # Status assessment
  if [ -n "${withC:-}" ] && [ "$withC" -ge 2000 ] && [ "${missing:-1}" -eq 0 ]; then
    echo ""
    echo "*** WARMING COMPLETE: coursesMissingCache=0 ***"
    row+="COMPLETE"
  elif [ "${missing:-0}" -le 50 ]; then
    row+="nearly warm"
  else
    row+="warming"
  fi

  echo "$row" >> "$LOG"
  echo "$row"

  return $RED_FLAG
}

# Ensure log has header
if [ ! -f "$LOG" ] || ! grep -q 'Timestamp' "$LOG"; then
  cat >> "$LOG" << 'HEADER'
# School Outbound Cache-Warming Trajectory

Commit: d18bc86 deployed ~2026-04-17 23:00 UTC
Target: coursesMissingCache=0, X-Cache-Layer=d1, <2s for all schools

| Probe | Timestamp (UTC) | Butler | Ivy Tech | Notre Dame | coursesWithCache | coursesMissingCache | Status |
|-------|-----------------|--------|----------|------------|-----------------|--------------------|--------|
HEADER
fi

case "${1:---once}" in
  --loop)
    echo "Probing every ${INTERVAL}s. Press Ctrl+C to stop."
    while true; do
      probe || true
      echo ""
      echo "Next probe in ${INTERVAL}s ($(date -u -v+${INTERVAL}S '+%H:%M UTC' 2>/dev/null || date -u -d "+${INTERVAL} seconds" '+%H:%M UTC' 2>/dev/null || echo '?'))"
      sleep "$INTERVAL"
    done
    ;;
  --once|*)
    probe
    ;;
esac
