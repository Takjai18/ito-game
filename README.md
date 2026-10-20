# 🕸️ Ito 命懸一線（Mode C 多機即時同步）

團契破冰遊戲。大螢幕做主持，團友手機掃 QR Code 入房，即時出牌、排序、揭曉。

介面唔綁某一個團契名，邊個團都可以用。

## 點玩

1. 主持開首頁，記住 4 位房號，撳「QR Code」俾團友掃。
2. 團友輸入名字，長按偷睇自己張 1–100 秘密數字，再打一句形容上軌道。
3. **蛛絲馬跡**：大家一齊排到由細至大。揭曉時如果新數字細過之前出過嘅最大數字，扣 1 點生命。
4. **紅線配對**：兩張一組，目標加總接近 100。大螢幕會顯示每組總和，生命由主持手動加減。
5. 生命見底就呢局完。過關之後再撳「派發新一局手牌」會升一級。生命見底再開新局，會補返滿血。

嚴禁直接講數字。

## 檔案

- `public/index.html` — 主持大螢幕同團友手機同一個頁面
- `worker.js` — Cloudflare Workers + Durable Object `ItoRoom`
- `wrangler.jsonc` — 部署設定。靜態頁放 `public/`，`/ws` 同 `/room` 先入 Worker

原本嘅 `wrangler.toml` 冇資產目錄，部署之後只會回傳 JSON，開唔到遊戲頁，所以改用 `wrangler.jsonc`。

## 本機

```bash
CI=1 npx --yes wrangler@4 dev
```

## 部署

帳號係 Ymtwill（`db0374b37171e14e52b085a4b4f0d1dc`）。

```bash
CI=1 npx --yes wrangler@4 deploy
```

線上地址：https://ito-game.ymtwill.workers.dev/
