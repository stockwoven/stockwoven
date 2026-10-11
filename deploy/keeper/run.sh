#!/bin/sh
# Runs the keeper and the devnet peg side by side. If either one stops, the machine exits and Fly
# restarts it, so neither runs without the other for long.
node_modules/.bin/tsx scripts/keeper.ts &
KEEPER=$!
node_modules/.bin/tsx scripts/peg.ts &
PEG=$!
while kill -0 "$KEEPER" 2>/dev/null && kill -0 "$PEG" 2>/dev/null; do sleep 5; done
echo "keeper or peg stopped; exiting so Fly restarts both"
kill "$KEEPER" "$PEG" 2>/dev/null
exit 1
