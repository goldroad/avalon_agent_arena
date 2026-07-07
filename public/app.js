const $ = (id) => document.getElementById(id);

let ws = null;
let current = { roomId: null, token: null, view: null };

const PROVIDERS = ["custom", "deepseek", "xiaomi", "aliyun", "doubao", "kimi"];
const ROLE_LABELS = {
  merlin: "merlin (梅林)",
  percival: "percival (派西维尔)",
  loyal: "loyal (忠臣)",
  assassin: "assassin (刺客)",
  morgana: "morgana (莫甘娜)",
  minion: "minion (爪牙)"
};

let roleConfigState = {};

function roleDeckForPlayerCount(playerCount) {
  const byCount = {
    5: ["merlin", "loyal", "loyal", "assassin", "morgana"],
    6: ["merlin", "percival", "loyal", "loyal", "assassin", "morgana"],
    7: ["merlin", "percival", "loyal", "loyal", "loyal", "assassin", "morgana"],
    8: ["merlin", "percival", "loyal", "loyal", "loyal", "assassin", "morgana", "minion"],
    9: ["merlin", "percival", "loyal", "loyal", "loyal", "loyal", "assassin", "morgana", "minion"],
    10: ["merlin", "percival", "loyal", "loyal", "loyal", "loyal", "loyal", "assassin", "morgana", "minion"]
  };
  return byCount[playerCount] ?? byCount[7];
}

function uniqueRolesForPlayerCount(playerCount) {
  return [...new Set(roleDeckForPlayerCount(playerCount))];
}

function createProviderSelect(value, onChange) {
  const sel = document.createElement("select");
  for (const p of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.appendChild(opt);
  }
  sel.value = value ?? "custom";
  sel.onchange = () => onChange(sel.value);
  return sel;
}

function renderRoleConfig() {
  const pc = Number($("playerCount").value);
  const roles = uniqueRolesForPlayerCount(pc);
  for (const r of roles) {
    if (!roleConfigState[r]) {
      roleConfigState[r] = { provider: $("defaultProvider")?.value ?? "custom", model: $("defaultModel")?.value ?? "", temperature: Number($("defaultTemp")?.value ?? 0.6) };
    }
  }
  for (const r of Object.keys(roleConfigState)) {
    if (!roles.includes(r)) delete roleConfigState[r];
  }

  const box = $("roleConfigBox");
  box.innerHTML = "";
  for (const role of roles) {
    const cfg = roleConfigState[role];
    const row = document.createElement("div");
    row.className = "row";
    row.style.marginTop = "10px";

    const label = document.createElement("span");
    label.className = "pill mono";
    label.textContent = ROLE_LABELS[role] ?? role;
    row.appendChild(label);

    const providerSel = createProviderSelect(cfg.provider, (v) => {
      roleConfigState[role].provider = v;
    });
    row.appendChild(providerSel);

    const modelInput = document.createElement("input");
    modelInput.placeholder = "model(必填，且各角色不同)";
    modelInput.value = cfg.model ?? "";
    modelInput.oninput = () => {
      roleConfigState[role].model = modelInput.value;
    };
    row.appendChild(modelInput);

    const tempInput = document.createElement("input");
    tempInput.type = "number";
    tempInput.step = "0.1";
    tempInput.min = "0";
    tempInput.max = "2";
    tempInput.value = String(typeof cfg.temperature === "number" && Number.isFinite(cfg.temperature) ? cfg.temperature : 0.6);
    tempInput.style.width = "90px";
    tempInput.oninput = () => {
      roleConfigState[role].temperature = Number(tempInput.value);
    };
    row.appendChild(tempInput);

    box.appendChild(row);
  }
}

function parseQuery() {
  const u = new URL(window.location.href);
  return {
    roomId: u.searchParams.get("roomId"),
    token: u.searchParams.get("token")
  };
}

function setPill(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
}

function renderSeats(view) {
  const grid = $("seatsGrid");
  grid.innerHTML = "";
  for (const s of view.seats ?? []) {
    const div = document.createElement("div");
    div.className = "card";
    const parts = [];
    parts.push(`<div class="mono">#${s.seatNo} <span class="pill">${s.type}</span></div>`);
    if (s.role) parts.push(`<div class="muted">role: ${s.role}</div>`);
    if (s.provider || s.model) parts.push(`<div class="muted">llm: ${s.provider ?? "-"} / ${s.model ?? "-"}</div>`);
    if (s.humanName) parts.push(`<div class="muted">name: ${s.humanName}</div>`);
    if (s.agentName) parts.push(`<div class="muted">agent: ${s.agentName}</div>`);
    if (s.label) parts.push(`<div class="muted">${s.label}</div>`);
    div.innerHTML = parts.join("");
    grid.appendChild(div);
  }
}

function renderChat(view) {
  const box = $("chatBox");
  box.innerHTML = "";
  const items = view.chat ?? [];
  for (const c of items) {
    const div = document.createElement("div");
    div.className = "chat-item";
    const who = c.seatNo ? `#${c.seatNo}` : "system";
    div.innerHTML = `<div class="mono muted">${c.ts} ${who}</div><div>${escapeHtml(c.text)}</div>`;
    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderView(view) {
  current.view = view;
  setPill("roomPill", `room: ${view.roomId}`);
  setPill("phasePill", `phase: ${view.phase}`);
  setPill("leaderPill", `leader: #${view.leaderSeat}`);
  setPill("scorePill", `score: S${view.scoreboard?.success ?? 0} / F${view.scoreboard?.fail ?? 0} (rej:${view.scoreboard?.rejectsInRow ?? 0})`);
  setText("scenarioBox", view.scenario ?? "-");

  const isGod = (view.seats ?? []).filter((s) => Boolean(s.role)).length > 1;
  const isPlayer = Boolean(view.privateInfo?.role);
  const who = isGod ? "上帝" : isPlayer ? "玩家" : "路人";
  setPill("viewPill", who);
  setPill("seatPill", isPlayer ? `seat: #${view.privateInfo?.seatNo ?? ""}` : "seat: -");

  renderSeats(view);
  renderChat(view);

  setText(
    "stateMeta",
    `playerCount=${view.playerCount} questNo=${view.questNo} round=${view.round}\nproposal=${JSON.stringify(view.proposal)}\nteamVote=${JSON.stringify(view.teamVote?.counts ?? null)}\nquest=${JSON.stringify(view.quest ?? null)}`
  );

  $("rawView").textContent = JSON.stringify(view, null, 2);
}

function connect(roomId, token) {
  current.roomId = roomId;
  current.token = token;
  $("roomIdInput").value = roomId ?? "";
  $("tokenInput").value = token ?? "";

  if (ws) {
    ws.close();
    ws = null;
  }

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${window.location.host}/ws?roomId=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`);

  ws.onopen = () => setPill("viewPill", "已连接");
  ws.onclose = () => setPill("viewPill", "未连接");
  ws.onerror = () => setPill("viewPill", "连接异常");
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") renderView(msg.view);
    } catch {}
  };
}

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  return json;
}

async function sendAction(action) {
  const roomId = current.roomId;
  const token = current.token;
  if (!roomId || !token) return;
  await api(`/api/rooms/${roomId}/action`, { token, action });
}

$("createBtn").onclick = async () => {
  const playerCount = Number($("playerCount").value);
  const humanCount = Number($("humanCount").value);
  const roleLlmMap = {};
  for (const [role, cfg] of Object.entries(roleConfigState)) {
    roleLlmMap[role] = { provider: cfg.provider, model: String(cfg.model ?? "").trim(), temperature: Number(cfg.temperature) };
  }

  const combos = new Map();
  for (const [role, cfg] of Object.entries(roleLlmMap)) {
    const key = `${cfg.provider}:${cfg.model}`;
    if (combos.has(key)) {
      alert(`角色模型配置重复：${combos.get(key)} 与 ${role} 使用了相同 Provider+Model。\n请保证每个角色都不同。`);
      return;
    }
    combos.set(key, role);
  }

  const defaultProvider = $("defaultProvider").value;
  const defaultModel = $("defaultModel").value || null;
  const defaultTemp = Number($("defaultTemp").value);

  const r = await api("/api/rooms", {
    playerCount,
    humanCount,
    aiProvider: defaultProvider,
    aiModel: defaultModel,
    aiTemperature: defaultTemp,
    roleLlmMap
  });
  const roomId = r.roomId;
  const godToken = r.tokens.god;
  const firstHumanSeat = Object.keys(r.tokens.players ?? {})[0];
  const firstHumanToken = firstHumanSeat ? r.tokens.players[firstHumanSeat] : null;

  const url = new URL(window.location.href);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("token", firstHumanToken ?? godToken);
  window.history.replaceState({}, "", url.toString());

  connect(roomId, firstHumanToken ?? godToken);
};

$("connectBtn").onclick = () => {
  const roomId = $("roomIdInput").value.trim();
  const token = $("tokenInput").value.trim();
  if (!roomId || !token) return;
  const url = new URL(window.location.href);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("token", token);
  window.history.replaceState({}, "", url.toString());
  connect(roomId, token);
};

$("sendChatBtn").onclick = async () => {
  const text = $("chatInput").value.trim();
  if (!text) return;
  $("chatInput").value = "";
  await sendAction({ type: "say", text });
};

$("proposeBtn").onclick = async () => {
  const raw = $("teamInput").value.trim();
  const team = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
  await sendAction({ type: "propose_team", team });
};

$("approveBtn").onclick = async () => sendAction({ type: "vote_team", vote: "approve" });
$("rejectBtn").onclick = async () => sendAction({ type: "vote_team", vote: "reject" });
$("questSuccessBtn").onclick = async () => sendAction({ type: "quest_action", action: "success" });
$("questFailBtn").onclick = async () => sendAction({ type: "quest_action", action: "fail" });

$("assassinateBtn").onclick = async () => {
  const target = Number($("assassinateInput").value.trim());
  if (!Number.isFinite(target)) return;
  await sendAction({ type: "assassinate", target });
};

const q = parseQuery();
if (q.roomId && q.token) {
  connect(q.roomId, q.token);
} else {
  setPill("viewPill", "未连接");
}

function clampHumanCount() {
  const pc = Number($("playerCount").value);
  const hc = Number($("humanCount").value);
  if (!Number.isFinite(pc) || !Number.isFinite(hc)) return;
  if (hc > pc) $("humanCount").value = String(pc);
}

$("playerCount").addEventListener("input", () => {
  clampHumanCount();
  renderRoleConfig();
});

$("humanCount").addEventListener("input", () => {
  clampHumanCount();
});

$("fillRolesBtn").onclick = () => {
  const provider = $("defaultProvider").value;
  const model = $("defaultModel").value ?? "";
  const temp = Number($("defaultTemp").value);
  for (const role of Object.keys(roleConfigState)) {
    roleConfigState[role] = { provider, model, temperature: temp };
  }
  renderRoleConfig();
};

renderRoleConfig();
