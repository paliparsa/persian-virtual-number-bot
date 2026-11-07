#!/usr/bin/env bash
# Run the full regression battery against src/ (plain Node, mocked Telegram /
# SmsFull / rate APIs — no network, no secrets needed).
# Usage: bash tests/run-all.sh   (or: npm test)
set -u
cd "$(dirname "$0")/.."
fail=0
for t in tests/test_v215.mjs tests/test_v216.mjs tests/test_v217.mjs tests/test_v218.mjs \
         tests/test_v219.mjs tests/test_v220.mjs tests/test_v221.mjs tests/test_v222.mjs \
         tests/test_v223.mjs tests/test_v224.mjs tests/test_v310.mjs tests/test_v311.mjs tests/test_regress.mjs tests/xlsx_check.mjs; do
  printf "%-28s " "$(basename "$t")"
  if timeout 180 node "$t" > /tmp/bm-test-out.txt 2>&1; then
    tail -1 /tmp/bm-test-out.txt
  else
    echo "FAILED"
    tail -15 /tmp/bm-test-out.txt
    fail=1
  fi
done
if [ "$fail" = "0" ]; then echo "ALL SUITES OK"; else echo "SOME SUITES FAILED"; exit 1; fi
