#!/usr/bin/env bash
# ── Knowledge Intelligence System — Quick Start ───────────────────────────────

echo ""
echo "  ◈  KIS — Knowledge Intelligence System"
echo "  ────────────────────────────────────────"
echo ""

# Check Python
if ! command -v python3 &>/dev/null; then
  echo "  ✗  Python 3 is required. Please install it first."
  exit 1
fi

# Check for API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "  ✗  ANTHROPIC_API_KEY not set."
  echo "     Export it before running:"
  echo "     export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

# Install dependencies
echo "  → Installing dependencies…"
pip install -q -r requirements.txt

echo ""
echo "  ✓  Dependencies installed"
echo "  → Starting server on http://localhost:5000"
echo ""
echo "  Open http://localhost:5000 in your browser"
echo "  Press Ctrl+C to stop"
echo ""

python3 app.py
