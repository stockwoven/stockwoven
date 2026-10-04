#!/usr/bin/env bash
# Dumps Meteora DAMM v2 (cp-amm) from mainnet so the LiteSVM tests can CPI into the real program.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p programs/stockwoven/tests/fixtures
solana program dump -u m cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG programs/stockwoven/tests/fixtures/cp_amm.so
