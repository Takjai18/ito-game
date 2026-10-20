export class ItoRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> { playerId, name, isHost }
    this.roomState = {
      roomCode: "",
      status: "LOBBY", // LOBBY | PLAYING | REVEALING | ROUND_END | GAME_OVER
      mode: "KUMONOITO", // KUMONOITO (合作排序) | AKAIITO (紅線湊百)
      level: 1,
      cardsPerPlayer: 1,
      maxLives: 5,
      lives: 5,
      topic: {
        category: "🍽️ 飲食日常",
        title: "放工/放學最想食嘅宵夜",
        minLabel: "1 = 減肥白烚菜 / 狗都唔食",
        maxLabel: "100 = 聽日世界末日都要食"
      },
      players: {}, // playerId -> { id, name, online, hand: [{ cardId, number, clue, submitted }] }
      lineup: [],  // Array of { cardId, playerId, playerName, number, clue, revealed, status }
      pairs: [],   // For AKAIITO mode: Array of { cardA, cardB, sum, diff, revealed }
      revealIndex: -1,
      lastUpdated: Date.now()
    };

    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get("roomState");
      if (saved) {
        this.roomState = saved;
      }
    });
  }

  async saveState() {
    this.roomState.lastUpdated = Date.now();
    await this.state.storage.put("roomState", this.roomState);
  }

  broadcast(includeSecrets = false) {
    for (const [ws, meta] of this.sessions.entries()) {
      try {
        ws.send(JSON.stringify(this.getSanitizedState(meta.playerId, meta.isHost)));
      } catch (err) {
        this.sessions.delete(ws);
      }
    }
  }

  getSanitizedState(requestingPlayerId, isHost) {
    const pubPlayers = {};
    for (const [pid, p] of Object.entries(this.roomState.players)) {
      pubPlayers[pid] = {
        id: p.id,
        name: p.name,
        online: p.online,
        hand: (p.hand || []).map(c => ({
          cardId: c.cardId,
          clue: c.clue,
          submitted: c.submitted,
          // 只有自己先睇到自己未揭曉嘅數字；或者主持開啟上帝視角時可選
          number: (pid === requestingPlayerId || this.roomState.status === "ROUND_END" || this.roomState.status === "GAME_OVER") ? c.number : null
        }))
      };
    }

    const pubLineup = (this.roomState.lineup || []).map(item => ({
      cardId: item.cardId,
      playerId: item.playerId,
      playerName: item.playerName,
      clue: item.clue,
      revealed: item.revealed,
      status: item.status, // PENDING | SAFE | FAIL
      number: (item.revealed || item.playerId === requestingPlayerId || this.roomState.status === "ROUND_END" || this.roomState.status === "GAME_OVER") ? item.number : null,
      hostPeekNumber: isHost ? item.number : null
    }));

    return {
      type: "STATE_UPDATE",
      state: {
        ...this.roomState,
        players: pubPlayers,
        lineup: pubLineup
      }
    };
  }

  shuffleDeck() {
    const deck = Array.from({ length: 100 }, (_, i) => i + 1);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader !== "websocket") {
      return new Response(JSON.stringify({ status: "ok", room: this.roomState.roomCode }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
      });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const playerId = url.searchParams.get("playerId") || "p_" + Math.random().toString(36).slice(2, 9);
    const playerName = url.searchParams.get("name") || "團友";
    const isHost = url.searchParams.get("host") === "1";
    const roomCode = url.searchParams.get("room") || "8888";

    if (!this.roomState.roomCode) {
      this.roomState.roomCode = roomCode;
    }

    this.sessions.set(server, { playerId, name: playerName, isHost });

    if (!isHost) {
      if (!this.roomState.players[playerId]) {
        this.roomState.players[playerId] = {
          id: playerId,
          name: playerName,
          online: true,
          hand: []
        };
      } else {
        this.roomState.players[playerId].name = playerName;
        this.roomState.players[playerId].online = true;
      }
      await this.saveState();
    }

    this.broadcast();

    server.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleMessage(server, msg);
      } catch (e) {
        server.send(JSON.stringify({ type: "ERROR", message: e.message }));
      }
    });

    server.addEventListener("close", async () => {
      const meta = this.sessions.get(server);
      this.sessions.delete(server);
      if (meta && !meta.isHost && this.roomState.players[meta.playerId]) {
        this.roomState.players[meta.playerId].online = false;
        await this.saveState();
        this.broadcast();
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(ws, msg) {
    const meta = this.sessions.get(ws);
    if (!meta) return;

    switch (msg.action) {
      case "SET_CONFIG": {
        if (msg.mode) this.roomState.mode = msg.mode;
        if (typeof msg.maxLives === "number") {
          this.roomState.maxLives = msg.maxLives;
          this.roomState.lives = msg.maxLives;
        }
        if (typeof msg.cardsPerPlayer === "number") {
          this.roomState.cardsPerPlayer = Math.max(1, Math.min(3, msg.cardsPerPlayer));
        }
        if (msg.topic) this.roomState.topic = msg.topic;
        break;
      }

      case "SET_TOPIC": {
        if (msg.topic) this.roomState.topic = msg.topic;
        break;
      }

      case "START_ROUND": {
        const playerIds = Object.keys(this.roomState.players);
        if (playerIds.length === 0) {
          ws.send(JSON.stringify({ type: "ERROR", message: "未有團友入房。請先出 QR Code，或者加測試團友。" }));
          return;
        }

        if (msg.topic) this.roomState.topic = msg.topic;
        if (typeof msg.level === "number" && msg.level >= 1 && msg.level <= 30) this.roomState.level = msg.level;
        if (typeof msg.cardsPerPlayer === "number") {
          this.roomState.cardsPerPlayer = Math.max(1, Math.min(3, msg.cardsPerPlayer));
        }
        if (this.roomState.lives <= 0) {
          this.roomState.lives = this.roomState.maxLives || 5;
        }

        const deck = this.shuffleDeck();
        let deckIdx = 0;
        this.roomState.lineup = [];
        this.roomState.pairs = [];
        this.roomState.revealIndex = -1;
        this.roomState.status = "PLAYING";

        for (const pid of playerIds) {
          const p = this.roomState.players[pid];
          p.hand = [];
          for (let c = 0; c < this.roomState.cardsPerPlayer; c++) {
            if (deckIdx < deck.length) {
              p.hand.push({
                cardId: `${pid}_c${c}_${Date.now()}`,
                number: deck[deckIdx++],
                clue: "",
                submitted: false
              });
            }
          }
        }
        break;
      }

      case "SUBMIT_CARD": {
        const p = this.roomState.players[meta.playerId];
        if (!p) return;
        const card = p.hand.find(c => c.cardId === msg.cardId) || p.hand[0];
        if (!card) return;

        card.clue = (msg.clue || "").trim().slice(0, 40) || "（口頭形容）";
        card.submitted = true;

        const existingIdx = this.roomState.lineup.findIndex(item => item.cardId === card.cardId);
        if (existingIdx >= 0) {
          this.roomState.lineup[existingIdx].clue = card.clue;
        } else {
          this.roomState.lineup.push({
            cardId: card.cardId,
            playerId: p.id,
            playerName: p.name,
            number: card.number,
            clue: card.clue,
            revealed: false,
            status: "PENDING"
          });
        }
        break;
      }

      case "MOVE_CARD": {
        const { fromIndex, toIndex } = msg;
        const list = this.roomState.lineup;
        if (fromIndex >= 0 && fromIndex < list.length && toIndex >= 0 && toIndex < list.length) {
          const [moved] = list.splice(fromIndex, 1);
          list.splice(toIndex, 0, moved);
        }
        break;
      }

      case "REORDER_LINEUP": {
        if (Array.isArray(msg.cardIds)) {
          const map = new Map(this.roomState.lineup.map(i => [i.cardId, i]));
          const newLineup = [];
          for (const cid of msg.cardIds) {
            if (map.has(cid)) {
              newLineup.push(map.get(cid));
              map.delete(cid);
            }
          }
          for (const rest of map.values()) newLineup.push(rest);
          this.roomState.lineup = newLineup;
        }
        break;
      }

      case "FORCE_ADD_UNSUBMITTED": {
        // 主持一鍵將未出牌嘅團友手牌放上軌道
        for (const p of Object.values(this.roomState.players)) {
          for (const card of (p.hand || [])) {
            if (!this.roomState.lineup.some(i => i.cardId === card.cardId)) {
              card.submitted = true;
              card.clue = card.clue || "（口頭形容）";
              this.roomState.lineup.push({
                cardId: card.cardId,
                playerId: p.id,
                playerName: p.name,
                number: card.number,
                clue: card.clue,
                revealed: false,
                status: "PENDING"
              });
            }
          }
        }
        break;
      }

      case "REVEAL_NEXT": {
        if (this.roomState.lineup.length === 0) return;
        this.roomState.status = "REVEALING";
        const nextIdx = this.roomState.lineup.findIndex(item => !item.revealed);
        if (nextIdx === -1) {
          this.roomState.status = "ROUND_END";
          break;
        }

        const current = this.roomState.lineup[nextIdx];
        current.revealed = true;
        this.roomState.revealIndex = nextIdx;

        if (this.roomState.mode === "KUMONOITO") {
          // 比較之前所有已揭曉並有效嘅最大數字
          let maxPrev = -1;
          for (let i = 0; i < nextIdx; i++) {
            if (this.roomState.lineup[i].number > maxPrev) {
              maxPrev = this.roomState.lineup[i].number;
            }
          }
          if (current.number >= maxPrev) {
            current.status = "SAFE";
          } else {
            current.status = "FAIL";
            this.roomState.lives = Math.max(0, this.roomState.lives - 1);
          }
        } else {
          // 紅線模式：兩張一組計加總同 100 嘅差距
          current.status = "SAFE";
        }

        const allDone = this.roomState.lineup.every(i => i.revealed);
        if (this.roomState.lives <= 0) {
          this.roomState.status = "GAME_OVER";
        } else if (allDone) {
          this.roomState.status = "ROUND_END";
        }
        break;
      }

      case "ADJUST_LIVES": {
        this.roomState.lives = Math.max(0, Math.min(10, this.roomState.lives + (msg.delta || 0)));
        if (this.roomState.lives > 0 && this.roomState.status === "GAME_OVER") {
          this.roomState.status = "REVEALING";
        }
        break;
      }

      case "REMOVE_PLAYER": {
        if (msg.playerId && this.roomState.players[msg.playerId]) {
          delete this.roomState.players[msg.playerId];
          this.roomState.lineup = this.roomState.lineup.filter(i => i.playerId !== msg.playerId);
        }
        break;
      }

      case "ADD_BOT": {
        const botId = "bot_" + Math.random().toString(36).slice(2, 7);
        const botNames = ["測試團友A", "測試團友B", "測試團友C", "測試團友D", "測試團友E", "測試團友F"];
        const count = Object.keys(this.roomState.players).length;
        this.roomState.players[botId] = {
          id: botId,
          name: botNames[count % botNames.length] + (count + 1),
          online: true,
          hand: []
        };
        break;
      }

      case "RESET_GAME": {
        this.roomState.status = "LOBBY";
        this.roomState.level = 1;
        this.roomState.lives = this.roomState.maxLives;
        this.roomState.lineup = [];
        this.roomState.revealIndex = -1;
        for (const p of Object.values(this.roomState.players)) {
          p.hand = [];
        }
        break;
      }
    }

    await this.saveState();
    this.broadcast();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname.startsWith("/ws") || url.pathname.startsWith("/room")) {
      const roomCode = (url.searchParams.get("room") || "8888").toUpperCase();
      const id = env.ITO_ROOMS.idFromName(roomCode);
      const stub = env.ITO_ROOMS.get(id);
      return stub.fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      JSON.stringify({
        service: "Ito Multiplayer Worker (Mode C)",
        status: "running",
        usage: "Connect via WebSocket at /ws?room=8888&playerId=xxx&name=xxx"
      }),
      { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }
};