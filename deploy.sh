#!/usr/bin/env bash
# 一键部署门户首页：commit + push + 服务器 pull
# 用法：./deploy.sh "commit message"
#
# 只管门户本身（index.html / logo.svg）。要更新游戏用服务器上的 update-games.sh。

set -e
cd "$(dirname "$0")"

SERVER_HOST="${SUSHI_SERVER_HOST:-root@207.148.98.206}"
SERVER_PATH="${SUSHI_SERVER_PATH:-/opt/games/sushigamelab}"
PUBLIC_URL="https://sushigamelab.com/"

MSG="${1:-Update portal}"

git add -A
if git diff --cached --quiet; then
  echo "(没有新改动,跳过 commit)"
else
  git commit -m "$MSG"
fi

echo
echo "→ 推送到 GitHub..."
git push

echo
echo "→ 通知服务器拉取..."
ssh "$SERVER_HOST" "cd '$SERVER_PATH' && git pull --rebase"

echo
echo "✅ 部署完成:"
echo "   $PUBLIC_URL"
