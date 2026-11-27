#!/usr/bin/env bash
# 一张商品图 → 一条带货视频，最小的完整流程。
#
# 用法：./examples/video-from-product-image.sh ./商品图.jpg "镜头描述"
set -euo pipefail

IMG="${1:?第一个参数给商品图路径}"
PROMPT="${2:?第二个参数给镜头描述，例如：产品置于浅色桌面，镜头缓慢推近，柔和自然光}"

CLI="node $(dirname "$0")/../scripts/linkpix.mjs"

# 1) 确认登录着
$CLI whoami > /dev/null || { echo "先跑一次 login"; $CLI login; }

# 2) 先按免费模型预演一遍，看清要花多少
$CLI video --image "$IMG" --prompt "$PROMPT" --duration 5 --dry-run

# 3) 真跑，等出片，落到 ./out
$CLI video --image "$IMG" --prompt "$PROMPT" --duration 5 \
  --model Viduq2-turbo --wait --out ./out
