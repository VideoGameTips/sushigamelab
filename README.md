<div align="center">

<img src="logo.svg" width="110" alt="Sushi Game Lab">

# Sushi Game Lab · 寿司游戏实验室

**一个小孩做的游戏，都能在浏览器里直接玩。**

### ▶ [sushigamelab.com](https://sushigamelab.com/)

*Free browser games made by a kid — no account, no install, no ads.*

</div>

---

这个仓库只有**门户首页**（`index.html` + `logo.svg`）。
每个游戏住在它自己的仓库里，在服务器上各自 clone 成站点根目录下的一个子目录。

## 站点结构

```
/opt/games/sushigamelab/          ← 这个仓库
├── index.html                    ← 门户首页
├── logo.svg
├── irontide/                     ← VideoGameTips/irontide
├── pvp/                          ← VideoGameTips/pvp-game       （带 Node 后端）
├── battle-sim/                   ← VideoGameTips/2d-battle-simulator
├── army-sim/                     ← VideoGameTips/game2
├── last-stand/                   ← VideoGameTips/last-stand
├── invasion/                     ← VideoGameTips/Invasion
├── survivor/                     ← VideoGameTips/Survivor-game
├── light-cycles/                 ← VideoGameTips/t-r-o-n
└── planefight/                   ← VideoGameTips/planefight
```

Caddy 对这个目录用的是**单一 root**，目录名直接就是网址：
`/last-stand/` → `sushigamelab.com/last-stand/`。

## 加一个新游戏

```bash
ssh root@<vps> 'git clone https://github.com/VideoGameTips/<repo>.git /opt/games/sushigamelab/<网址名>'
```

**不用改 Caddy 配置，也不用重启 Caddy** —— 目录一放上去网址就通了。
然后在 `index.html` 里加一张卡片、把目录名加进 `.gitignore` 和 `update-games.sh` 的清单，`./deploy.sh` 推上去。

例外只有带后端的游戏（目前只有 `pvp`），要额外配 systemd 服务和反向代理。

## 更新

```bash
# 更新门户首页
./deploy.sh "改了什么"

# 更新所有游戏到各自仓库最新版（在服务器上跑）
ssh root@<vps> 'bash /opt/games/sushigamelab/update-games.sh'
```

## 基础设施

- VPS 上和 `game.boobank.com`、`snapmonster.io` 并行跑，互不影响
- 域名在**独立的 Cloudflare 账号**下，走独立的 named tunnel `sushigamelab`
- 没有对公网开放任何端口，全部流量走 Cloudflare 隧道进 Caddy
- 访问日志 `/var/log/caddy/sushigamelab.log`

> ⚠️ 改 Caddyfile 时如果新增了 `log` 指令，**必须先把日志文件建出来**
> （`install -o caddy -g caddy -m 640 /dev/null /var/log/caddy/<名>.log`），
> 否则 Caddy 起不来，整台机器上所有站点一起下线。`caddy validate` 通过**不代表**能启动。
