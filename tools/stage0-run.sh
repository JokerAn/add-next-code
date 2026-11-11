#!/usr/bin/env bash
# 阶段 0 实测一键脚本：依次运行 connect / stop / cache / errors / length（可选 header），结果同时写入文件。
# API Key 用不回显的方式现场输入，不进入 shell 历史，也不写入结果文件。
# 用法：
#   bash tools/stage0-run.sh
#   bash tools/stage0-run.sh --file <源文件> --line <0基行号> --col <列>     # 额外跑头部干扰对比
set -u
cd "$(dirname "$0")/.."
OUT="${STAGE0_OUT:-/tmp/fim-review/stage0-results.txt}"
mkdir -p "$(dirname "$OUT")"

if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  read -rs -p "请输入 DeepSeek API Key（输入不回显）: " DEEPSEEK_API_KEY
  echo
  export DEEPSEEK_API_KEY
fi

{
  echo "# 阶段 0 实测  $(date '+%F %T')"
  echo "# node $(node --version)  endpoint=${FIM_ENDPOINT:-默认}"
  for mode in connect stop cache errors; do
    echo; echo "##### $mode"
    node tools/fim-smoke.mjs "$mode" 2>&1
  done
  echo; echo "##### length（1K 起每步翻倍，最大 128000 字符）"
  node tools/fim-smoke.mjs length --max-chars 128000 2>&1
  if [ "${1:-}" = "--file" ]; then
    echo; echo "##### header"
    node tools/fim-smoke.mjs header "$@" 2>&1
  fi
} | tee "$OUT"

echo
echo "完成。结果已写入：$OUT"
