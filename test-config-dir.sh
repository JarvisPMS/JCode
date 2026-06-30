#!/bin/bash

# ---- Settings (modify these values) ----
CONFIG_DIR="$USERPROFILE/.claude-test"
WORK_DIR="$USERPROFILE/Desktop/claudetest"
BASE_URL="https://coding.dashscope.aliyuncs.com/apps/anthropic"
API_KEY="your-api-key-here"
MODEL="qwen3.5-plus"
PROMPT="What is your underlying model? Please tell me your exact model name and version."
# ---- End of settings ----

echo "============================================"
echo "  JCode ConfigDir Test Script (bash)"
echo "============================================"
echo ""
echo "[Config]"
echo "  CONFIG_DIR = $CONFIG_DIR"
echo "  WORK_DIR   = $WORK_DIR"
echo "  BASE_URL   = $BASE_URL"
echo "  MODEL      = $MODEL"
echo "  PROMPT     = $PROMPT"
echo ""

# ============================================
# Step 1: Record BEFORE state
# ============================================
echo "[BEFORE] CONFIG_DIR state:"
echo ""
if [ -d "$CONFIG_DIR" ]; then
    echo "  Directory exists:"
    echo "  ----------------------------------"
    ls -laR "$CONFIG_DIR"
    echo "  ----------------------------------"
else
    echo "  Directory does NOT exist yet."
fi

SIBLING_JSON="${CONFIG_DIR}.json"
echo ""
echo "  Sibling JSON: $SIBLING_JSON"
if [ -f "$SIBLING_JSON" ]; then
    echo "  [EXISTS]"
    cat "$SIBLING_JSON"
else
    echo "  [NOT FOUND]"
fi

# ============================================
# Step 2: Ensure work dir exists
# ============================================
if [ ! -d "$WORK_DIR" ]; then
    echo ""
    echo "  Work dir not found, creating: $WORK_DIR"
    mkdir -p "$WORK_DIR"
fi

# ============================================
# Step 3: Launch Claude
# ============================================
echo ""
echo "============================================"
echo "[LAUNCHING] Claude with custom config dir..."
echo "============================================"
echo ""

unset CLAUDECODE

cd "$WORK_DIR" || exit 1

CLAUDE_CONFIG_DIR="$CONFIG_DIR" \
ANTHROPIC_BASE_URL="$BASE_URL" \
ANTHROPIC_API_KEY="$API_KEY" \
claude --model "$MODEL" -p "$PROMPT"

echo ""

# ============================================
# Step 4: Record AFTER state
# ============================================
echo "============================================"
echo "[AFTER] CONFIG_DIR state after Claude exit:"
echo "============================================"
echo ""

if [ -d "$CONFIG_DIR" ]; then
    echo "  CONFIG_DIR full tree:"
    echo "  ----------------------------------"
    ls -laR "$CONFIG_DIR"
    echo "  ----------------------------------"
    echo ""

    echo "  [Key Files]"
    if [ -f "$CONFIG_DIR/.claude.json" ]; then
        echo "  .claude.json: EXISTS"
        echo "  Contents:"
        cat "$CONFIG_DIR/.claude.json"
        echo ""
    else
        echo "  .claude.json: NOT FOUND"
    fi

    if [ -f "$CONFIG_DIR/settings.json" ]; then
        echo "  settings.json: EXISTS"
        cat "$CONFIG_DIR/settings.json"
        echo ""
    else
        echo "  settings.json: NOT FOUND"
    fi

    if [ -f "$CONFIG_DIR/.credentials.json" ]; then
        echo "  .credentials.json: EXISTS (OAuth)"
    else
        echo "  .credentials.json: NOT FOUND (normal for API Key mode)"
    fi

    if [ -d "$CONFIG_DIR/projects" ]; then
        echo "  projects/: EXISTS"
        ls -la "$CONFIG_DIR/projects/"
    else
        echo "  projects/: NOT FOUND"
    fi
else
    echo "  CONFIG_DIR does not exist! Claude did not use this directory."
fi

echo ""
echo "  Sibling JSON: $SIBLING_JSON"
if [ -f "$SIBLING_JSON" ]; then
    echo "  [EXISTS]"
    cat "$SIBLING_JSON"
else
    echo "  [NOT FOUND]"
fi

echo ""
echo "============================================"
echo "  Test complete!"
echo "============================================"
