#!/usr/bin/env bash
# 把站点上的游戏更新到各自仓库的最新版。在 VPS 上跑。
#
#   ./update-games.sh              # 全部更新
#   ./update-games.sh irontide     # 只更新一个
#   ./update-games.sh pvp irontide # 更新指定的几个
#
# 每个游戏是它自己仓库的一份独立 clone，所以更新就是逐个 fetch + reset。
# 用 reset --hard 而不是 pull：服务器上的副本是只读部署，本地不该有任何改动，
# 有的话也应该被覆盖掉，而不是留下一个能让下次 pull 冲突的现场。

set -u
ROOT="${SITE_ROOT:-/opt/games/sushigamelab}"

ALL="irontide pvp battle-sim army-sim last-stand invasion survivor light-cycles planefight"

if [ $# -gt 0 ]; then
  GAMES=""
  for want in "$@"; do
    found=""
    for g in $ALL; do [ "$g" = "$want" ] && found=1; done
    if [ -z "$found" ]; then
      # 打错名字时静默跳过最糟糕：看着像更新成功了,其实什么都没动
      echo "❌ 没有叫「$want」的游戏。可选：$ALL" >&2
      exit 2
    fi
    GAMES="$GAMES $want"
  done
else
  GAMES="$ALL"
fi

fail=0
for g in $GAMES; do
  d="$ROOT/$g"
  if [ ! -d "$d/.git" ]; then
    printf '%-14s ⚠️  跳过（不是 git 目录）\n' "$g"
    continue
  fi
  before=$(git -C "$d" rev-parse --short HEAD 2>/dev/null)
  if git -C "$d" fetch -q origin 2>/dev/null && git -C "$d" reset -q --hard origin/HEAD 2>/dev/null; then
    after=$(git -C "$d" rev-parse --short HEAD)
    if [ "$before" = "$after" ]; then
      printf '%-14s ✓  已是最新 (%s)\n' "$g" "$after"
    else
      printf '%-14s ⬆️  %s → %s\n' "$g" "$before" "$after"
    fi
  else
    printf '%-14s ❌ 更新失败\n' "$g"; fail=1
  fi
done

# pvp 是唯一带后端的游戏：拉了新代码要重启服务，否则跑的还是旧进程。
# 只在这轮真的更新了 pvp 时才重启——不然更新一个静态游戏会顺手把在线玩家踢掉。
if echo " $GAMES " | grep -q " pvp " && [ -d "$ROOT/pvp/.git" ]; then
  echo
  echo "→ 重启 pvp 服务端"
  systemctl restart sushigamelab-pvp && systemctl is-active sushigamelab-pvp
fi

exit $fail
