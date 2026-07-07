const $ = (id) => document.getElementById(id);

const PROVIDERS = ["custom", "deepseek", "xiaomi", "aliyun", "doubao", "kimi"];
const DEFAULT_PROVIDER = "doubao";
const DEFAULT_MODEL = "doubao-seed-2-0-pro-260215";
const ROLE_LABELS = {
  merlin: "merlin (梅林)",
  percival: "percival (派西维尔)",
  loyal: "loyal (忠臣)",
  assassin: "assassin (刺客)",
  morgana: "morgana (莫甘娜)",
  minion: "minion (爪牙)"
};

let roleConfigState = {};
const CLIENT_LOG_LIMIT = 120;
const SERVER_LOG_REFRESH_MS = 5000;
const API_TIMEOUT_MS = 20000;
const clientLogs = [];
let serverLogTimer = null;
let lastCreatedRoom = null;

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function nowLabel() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function stringifyLogPart(part) {
  if (part instanceof Error) return part.stack || part.message || String(part);
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

function renderClientLogs() {
  const output = $("clientLogOutput");
  if (!output) return;
  output.textContent = clientLogs.length ? clientLogs.join("\n") : "等待日志输出...";
  output.scrollTop = output.scrollHeight;
}

function appendClientLog(level, ...parts) {
  const message = parts.map(stringifyLogPart).join(" ");
  clientLogs.push(`[${nowLabel()}] [${level}] ${message}`);
  if (clientLogs.length > CLIENT_LOG_LIMIT) {
    clientLogs.splice(0, clientLogs.length - CLIENT_LOG_LIMIT);
  }
  renderClientLogs();
}

function installClientLogCapture() {
  if (window.__homeLogCaptureInstalled) return;
  window.__homeLogCaptureInstalled = true;

  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => {
      rawConsole[level](...args);
      appendClientLog(level.toUpperCase(), ...args);
    };
  }

  window.addEventListener("error", (event) => {
    appendClientLog("ERROR", event.message || "页面运行错误");
  });

  window.addEventListener("unhandledrejection", (event) => {
    appendClientLog("ERROR", "未处理的 Promise 异常", event.reason ?? "unknown");
  });
}

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

function clampHumanCount() {
  const pc = Number($("playerCount").value);
  const hc = Number($("humanCount").value);
  if (!Number.isFinite(pc) || !Number.isFinite(hc)) return;
  if (hc > pc) $("humanCount").value = String(pc);
}

async function fetchProviderModel(provider) {
  try {
    const res = await fetch(`/api/llm/config?provider=${encodeURIComponent(provider)}`);
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok !== false && json.config?.model) {
      return json.config.model;
    }
  } catch (err) {
    console.warn(`获取 ${provider} 模型配置失败:`, err);
  }
  return null;
}

function createProviderSelect(value, onChange, onModelAutoFill) {
  const sel = document.createElement("select");
  for (const p of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    sel.appendChild(opt);
  }
  sel.value = value ?? "custom";
  sel.onchange = async () => {
    const provider = sel.value;
    onChange(provider);
    if (onModelAutoFill) {
      const model = await fetchProviderModel(provider);
      if (model) {
        onModelAutoFill(model);
      }
    }
  };
  return sel;
}

function shuffleList(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeModelConfig(cfg) {
  const model = String(cfg?.model ?? "").trim();
  if (!model) return null;
  const temperatureRaw = Number(cfg?.temperature);
  return {
    provider: cfg?.provider ?? "custom",
    model,
    temperature: Number.isFinite(temperatureRaw) ? temperatureRaw : 0.6
  };
}

function dedupeModelPool(configs) {
  const pool = [];
  const seen = new Set();

  const pushIfValid = (cfg) => {
    const normalized = normalizeModelConfig(cfg);
    if (!normalized) return;
    const key = `${normalized.provider}:${normalized.model}:${normalized.temperature}`;
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(normalized);
  };

  for (const cfg of configs) {
    pushIfValid(cfg);
  }
  return pool;
}

function collectLocalConfiguredModels() {
  const configs = [];
  configs.push({
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    temperature: Number($("defaultTemp")?.value ?? 0.6)
  });

  for (const cfg of Object.values(roleConfigState)) {
    configs.push(cfg);
  }

  return dedupeModelPool(configs);
}

async function fetchDoubaoModelPoolFromServer() {
  const temp = Number($("defaultTemp")?.value ?? 0.6);
  const res = await fetch("/api/llm/config?provider=doubao");
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);

  const stored = json.stored ?? {};
  const config = json.config ?? {};
  const models = Array.isArray(stored.models) ? stored.models : [];
  const resolvedModels = models.length > 0 ? models : (config.model ? [config.model] : []);

  return dedupeModelPool(
    resolvedModels.map((model) => ({
      provider: "doubao",
      model,
      temperature: temp
    }))
  );
}

async function fetchConfiguredModelsFromServer() {
  const temp = Number($("defaultTemp")?.value ?? 0.6);
  const statusRes = await fetch("/api/llm/providers");
  const statusJson = await statusRes.json().catch(() => ({}));
  if (!statusRes.ok || statusJson.ok === false) {
    throw new Error(statusJson.error ?? `HTTP ${statusRes.status}`);
  }

  const availableProviders = (statusJson.providers ?? [])
    .filter((item) => item.provider !== "custom" && item.hasBaseUrl && item.hasApiKey && item.hasModel)
    .map((item) => item.provider);

  const detailResults = await Promise.all(
    availableProviders.map(async (provider) => {
      const res = await fetch(`/api/llm/config?provider=${encodeURIComponent(provider)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      return {
        provider,
        model: json.config?.model ?? "",
        temperature: temp
      };
    })
  );

  return dedupeModelPool(detailResults);
}

function prioritizeModelPool(pool) {
  const nonDefault = pool.filter((cfg) => cfg.provider !== DEFAULT_PROVIDER);
  const defaultOnly = pool.filter((cfg) => cfg.provider === DEFAULT_PROVIDER);
  return [...shuffleList(nonDefault), ...shuffleList(defaultOnly)];
}

function collectConfiguredModels() {
  const localPool = collectLocalConfiguredModels();
  if (localPool.length <= 1 && localPool[0]?.provider === DEFAULT_PROVIDER && localPool[0]?.model === DEFAULT_MODEL) {
    return localPool;
  }

  return prioritizeModelPool(localPool);
}

async function resolveRandomAssignmentPool() {
  const activeGlobalProvider = $("defaultProvider")?.value ?? DEFAULT_PROVIDER;

  try {
    if (activeGlobalProvider === "doubao") {
      const doubaoPool = await fetchDoubaoModelPoolFromServer();
      if (doubaoPool.length > 0) {
        appendClientLog("INFO", `已按豆包全局模型策略加载 ${doubaoPool.length} 个候选模型`);
        return doubaoPool;
      }
    }

    const serverPool = prioritizeModelPool(await fetchConfiguredModelsFromServer());
    if (serverPool.length > 0) {
      appendClientLog("INFO", `从 LLM 配置读取到 ${serverPool.length} 个可用模型`);
      return serverPool;
    }
  } catch (err) {
    appendClientLog("WARN", "读取 LLM 配置失败，改用页面已配置模型", err);
  }

  const localPool = collectConfiguredModels();
  appendClientLog("INFO", `回退到页面已配置模型池，共 ${localPool.length} 个`);
  return localPool;
}

function buildAssignmentPool(modelPool, requiredCount) {
  const assignmentPool = [];
  while (assignmentPool.length < requiredCount) {
    assignmentPool.push(...shuffleList(modelPool));
  }

  return assignmentPool;
}

function modelPoolSummary(modelPool) {
  return modelPool.map((cfg) => `${cfg.provider}:${cfg.model}`).join(", ");
}

function renderRoleConfig() {
  const pc = Number($("playerCount").value);
  const roles = uniqueRolesForPlayerCount(pc);

  for (const r of roles) {
    if (!roleConfigState[r]) {
      roleConfigState[r] = {
        provider: DEFAULT_PROVIDER,
        model: "",
        temperature: Number($("defaultTemp")?.value ?? 0.6)
      };
    }
  }

  for (const r of Object.keys(roleConfigState)) {
    if (!roles.includes(r)) delete roleConfigState[r];
  }

  const box = $("roleConfigBox");
  box.innerHTML = "";

  for (const role of roles) {
    const cfg = roleConfigState[role];
    const wrap = document.createElement("div");
    wrap.className = "role-card";

    const name = document.createElement("div");
    name.className = "role-name";
    name.innerHTML = `<span class="pill mono">${ROLE_LABELS[role] ?? role}</span>`;
    wrap.appendChild(name);

    const modelInput = document.createElement("input");
    modelInput.type = "text";
    modelInput.placeholder = "model（可选；留空则使用全局模型/服务端兜底）";
    modelInput.value = cfg.model ?? "";
    modelInput.className = "field";
    modelInput.oninput = () => {
      roleConfigState[role].model = modelInput.value;
    };

    const providerSel = createProviderSelect(cfg.provider, (v) => {
      roleConfigState[role].provider = v;
    }, (autoModel) => {
      modelInput.value = autoModel;
      roleConfigState[role].model = autoModel;
    });
    providerSel.className = "field";
    wrap.appendChild(providerSel);

    wrap.appendChild(modelInput);

    const tempInput = document.createElement("input");
    tempInput.type = "number";
    tempInput.step = "0.1";
    tempInput.min = "0";
    tempInput.max = "2";
    tempInput.value = String(typeof cfg.temperature === "number" && Number.isFinite(cfg.temperature) ? cfg.temperature : 0.6);
    tempInput.className = "field";
    tempInput.oninput = () => {
      roleConfigState[role].temperature = Number(tempInput.value);
    };
    wrap.appendChild(tempInput);

    box.appendChild(wrap);
  }
}

async function api(path, body) {
  appendClientLog("INFO", `请求 ${path}`, body ?? {});
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    appendClientLog("INFO", `请求成功 ${path}`);
    return json;
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    appendClientLog("ERROR", `请求失败 ${path}`, isTimeout ? `timeout_after_${API_TIMEOUT_MS}ms` : err);
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

function buildRoleLlmMap() {
  const roleLlmMap = {};
  for (const [role, cfg] of Object.entries(roleConfigState)) {
    const model = String(cfg.model ?? "").trim();
    if (!model) continue;
    roleLlmMap[role] = { provider: cfg.provider, model, temperature: Number(cfg.temperature) };
  }

  const keys = Object.keys(roleLlmMap);
  if (keys.length === 0) return null;
  return roleLlmMap;
}

async function refreshServerLogs() {
  const output = $("serverLogOutput");
  if (!output) return;

  try {
    const res = await fetch("/api/runtime-logs?lines=80");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }

    const sections = [];
    const stdout = String(json.logs?.stdout ?? "").trim();
    const stderr = String(json.logs?.stderr ?? "").trim();
    sections.push("[server.out.log]");
    sections.push(stdout || "(暂无输出)");
    sections.push("");
    sections.push("[server.err.log]");
    sections.push(stderr || "(暂无输出)");
    output.textContent = sections.join("\n");
    output.scrollTop = output.scrollHeight;
  } catch (err) {
    output.textContent = `日志读取失败：${String(err?.message ?? err)}`;
    appendClientLog("ERROR", "读取服务端日志失败", err);
  }
}

function startServerLogPolling() {
  if (serverLogTimer) window.clearInterval(serverLogTimer);
  refreshServerLogs();
  serverLogTimer = window.setInterval(refreshServerLogs, SERVER_LOG_REFRESH_MS);
}

function toGame(roomId, token) {
  const url = new URL(`${window.location.origin}/game.html`);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("token", token);
  window.location.href = url.toString();
}

function gameUrl(roomId, token) {
  const url = new URL(`${window.location.origin}/game.html`);
  url.searchParams.set("roomId", roomId);
  url.searchParams.set("token", token);
  return url.toString();
}

function sortSeatKeys(keys) {
  return [...keys].sort((a, b) => Number(a) - Number(b));
}

function renderJoinLinks(room) {
  lastCreatedRoom = room;
  const card = $("joinLinksCard");
  if (!card) return;
  card.style.display = "";

  const roomId = room?.roomId ?? "-";
  const tokens = room?.tokens ?? {};
  $("createdRoomId").textContent = roomId;

  const godUrl = tokens.god ? gameUrl(roomId, tokens.god) : "#";
  const spectatorUrl = tokens.spectator ? gameUrl(roomId, tokens.spectator) : "#";

  const godLink = $("godViewLink");
  const spectatorLink = $("spectatorViewLink");
  if (godLink) godLink.href = godUrl;
  if (spectatorLink) spectatorLink.href = spectatorUrl;

  $("enterGodBtn").onclick = () => tokens.god && toGame(roomId, tokens.god);
  $("enterSpectatorBtn").onclick = () => tokens.spectator && toGame(roomId, tokens.spectator);

  const players = tokens.players ?? {};
  const playerKeys = sortSeatKeys(Object.keys(players));
  const playerRow = $("playerLinkRow");
  const sel = $("playerViewSelect");
  const playerLink = $("playerViewLink");
  const enterPlayerBtn = $("enterPlayerBtn");

  if (!sel || !playerLink || !enterPlayerBtn || !playerRow) return;

  if (playerKeys.length === 0) {
    playerRow.style.display = "none";
    return;
  }

  playerRow.style.display = "";
  sel.innerHTML = "";
  for (const seatKey of playerKeys) {
    const opt = document.createElement("option");
    opt.value = seatKey;
    opt.textContent = `玩家 ${seatKey}`;
    sel.appendChild(opt);
  }

  const updatePlayerHref = () => {
    const seatKey = String(sel.value);
    const token = players[seatKey];
    const href = token ? gameUrl(roomId, token) : "#";
    playerLink.href = href;
    enterPlayerBtn.onclick = () => token && toGame(roomId, token);
  };
  sel.onchange = updatePlayerHref;
  sel.value = playerKeys[0];
  updatePlayerHref();
}

$("createBtn").onclick = async () => {
  const btn = $("createBtn");
  const prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "创建中...";
  appendClientLog("INFO", "开始创建房间");
  try {
    const playerCount = Number($("playerCount").value);
    const humanCount = Number($("humanCount").value);

    const defaultProvider = $("defaultProvider")?.value || DEFAULT_PROVIDER;
    const defaultModel = $("defaultModel")?.value || DEFAULT_MODEL;
    const defaultTemp = Number($("defaultTemp").value);

    const roles = Object.keys(roleConfigState);
    const needAutoAssignDoubaoRoles = defaultProvider === "doubao" && roles.length > 0 && !roles.some((role) => {
      const cfg = roleConfigState[role];
      return cfg && cfg.model && cfg.model !== defaultModel;
    });

    if (needAutoAssignDoubaoRoles) {
      appendClientLog("INFO", "检测到豆包全局模型策略，自动为角色随机分配不同豆包模型");
      await resolveRandomAssignmentPool();
      $("randomizeRolesBtn").click();
    }

    const roleLlmMap = buildRoleLlmMap();

    const r = await api("/api/rooms", {
      playerCount,
      humanCount,
      aiProvider: defaultProvider,
      aiModel: defaultModel,
      aiTemperature: defaultTemp,
      roleLlmMap
    });

    appendClientLog("INFO", `房间创建成功 roomId=${r.roomId}`);
    renderJoinLinks(r);
  } catch (err) {
    console.error(err);
    window.alert(String(err?.message ?? err));
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
};

$("fillRolesBtn").onclick = () => {
  const provider = $("defaultProvider")?.value || DEFAULT_PROVIDER;
  const model = $("defaultModel")?.value || DEFAULT_MODEL;
  const temp = Number($("defaultTemp").value);
  for (const role of Object.keys(roleConfigState)) {
    roleConfigState[role] = { provider, model, temperature: temp };
  }
  appendClientLog("INFO", `已快速填充 ${Object.keys(roleConfigState).length} 个角色`);
  renderRoleConfig();
};

$("randomizeRolesBtn").onclick = async () => {
  const roles = Object.keys(roleConfigState);
  const modelPool = await resolveRandomAssignmentPool();

  if (roles.length === 0) {
    appendClientLog("WARN", "当前没有可分配的角色");
    return;
  }

  if (modelPool.length === 0) {
    const message = "请先在 LLM 配置页完成至少一个 provider 的模型配置，再执行随机分配。";
    appendClientLog("WARN", message);
    window.alert(message);
    return;
  }

  const assignmentPool = buildAssignmentPool(modelPool, roles.length);

  roles.forEach((role, index) => {
    const cfg = assignmentPool[index];
    roleConfigState[role] = { ...cfg };
  });

  appendClientLog("INFO", `已随机分配 ${roles.length} 个角色，模型池=${modelPoolSummary(modelPool)}`);
  renderRoleConfig();
};

$("playerCount").addEventListener("input", () => {
  clampHumanCount();
  renderRoleConfig();
});

$("humanCount").addEventListener("input", () => {
  clampHumanCount();
});

$("joinRoomLink").onclick = (e) => {
  e.preventDefault();
  const roomId = window.prompt("请输入 roomId");
  if (!roomId) return;
  const token = window.prompt("请输入 token（上帝/路人/玩家 token 均可）");
  if (!token) return;
  appendClientLog("INFO", `手动加入房间 ${roomId.trim()}`);
  toGame(roomId.trim(), token.trim());
};

$("refreshLogsBtn").onclick = () => {
  appendClientLog("INFO", "手动刷新服务端日志");
  refreshServerLogs();
};

// 阶段中文名映射
function phaseLabel(phase) {
  const map = {
    team_proposal: "组队提议",
    team_vote: "组队投票",
    quest_vote: "任务投票",
    assassination: "刺杀阶段",
    game_over: "已结束"
  };
  return map[phase] ?? phase;
}

// 获取并渲染进行中的对局
async function fetchActiveRooms() {
  try {
    const res = await fetch("/api/rooms/active");
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    renderActiveRooms(json.rooms ?? []);
  } catch (err) {
    appendClientLog("WARN", "获取进行中的对局失败", err);
  }
}

function renderActiveRooms(rooms) {
  const card = $("activeRoomsCard");
  const list = $("activeRoomsList");
  if (!card || !list) return;

  if (rooms.length === 0) {
    card.style.display = "none";
    return;
  }

  card.style.display = "";
  list.innerHTML = "";

  for (const room of rooms) {
    const item = document.createElement("div");
    item.className = "active-room-item";

    const info = document.createElement("div");
    info.className = "active-room-info";

    const roomIdShort = room.roomId.replace(/^room_/, "").slice(0, 8);
    const createdTime = new Date(room.createdAt).toLocaleString("zh-CN", { hour12: false });

    info.innerHTML = `
      <div class="mono" style="font-size: 13px; color: #b0baff">room_${roomIdShort}...</div>
      <div class="active-room-meta">
        <span class="pill">${room.playerCount}人局</span>
        <span class="pill">${phaseLabel(room.phase)}</span>
        <span class="pill">任务 ${room.questNo}</span>
        <span class="pill">S${room.score.success} / F${room.score.fail}</span>
        <span class="muted" style="font-size: 11px">${createdTime}</span>
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "active-room-actions";

    const godBtn = document.createElement("button");
    godBtn.textContent = "上帝视角";
    godBtn.style.fontSize = "12px";
    godBtn.style.padding = "5px 12px";
    godBtn.onclick = () => toGame(room.roomId, room.godToken);

    actions.appendChild(godBtn);
    item.appendChild(info);
    item.appendChild(actions);
    list.appendChild(item);
  }

  appendClientLog("INFO", `发现 ${rooms.length} 个进行中的对局`);
}

// 从服务器获取可用的 provider 和 model，填充全局模型下拉菜单
async function populateGlobalModelSelects() {
  const providerSelect = $("defaultProvider");
  const modelSelect = $("defaultModel");
  if (!providerSelect || !modelSelect) return;

  try {
    const statusRes = await fetch("/api/llm/providers");
    const statusJson = await statusRes.json().catch(() => ({}));
    if (!statusRes.ok || statusJson.ok === false) {
      throw new Error(statusJson.error ?? `HTTP ${statusRes.status}`);
    }

    // 筛选出已配置 baseUrl/apiKey/model 的 provider
    const availableProviders = (statusJson.providers ?? [])
      .filter((item) => item.provider !== "custom" && item.hasBaseUrl && item.hasApiKey && item.hasModel)
      .map((item) => item.provider);

    if (availableProviders.length === 0) {
      appendClientLog("INFO", "没有已配置的 provider，使用默认 doubao");
      return;
    }

    // 获取每个 provider 的详细配置（包含 model + 已配置模型列表）
    const providerModels = await Promise.all(
      availableProviders.map(async (provider) => {
        try {
          const res = await fetch(`/api/llm/config?provider=${encodeURIComponent(provider)}`);
          const json = await res.json().catch(() => ({}));
          if (!res.ok || json.ok === false) return null;
          const storedModels = Array.isArray(json.stored?.models) ? json.stored.models : [];
          const primaryModel = json.config?.model ?? "";
          const models = storedModels.length > 0 ? storedModels : (primaryModel ? [primaryModel] : []);
          return {
            provider,
            models
          };
        } catch {
          return null;
        }
      })
    );

    const validConfigs = providerModels.filter((c) => c && c.models.length > 0);
    if (validConfigs.length === 0) {
      appendClientLog("INFO", "没有可用的 model 配置，使用默认 doubao");
      return;
    }

    // 填充 provider 下拉菜单（去重）
    const uniqueProviders = [...new Set(validConfigs.map((c) => c.provider))];
    providerSelect.innerHTML = "";
    for (const provider of uniqueProviders) {
      const opt = document.createElement("option");
      opt.value = provider;
      opt.textContent = provider;
      providerSelect.appendChild(opt);
    }

    // 默认选中 DEFAULT_PROVIDER（如果有的话），否则选第一个
    if (uniqueProviders.includes(DEFAULT_PROVIDER)) {
      providerSelect.value = DEFAULT_PROVIDER;
    } else {
      providerSelect.value = uniqueProviders[0];
    }

    // 记录每个 provider 的可用模型，便于动态切换下拉选项
    const modelsByProvider = new Map();
    for (const cfg of validConfigs) {
      const list = modelsByProvider.get(cfg.provider) ?? [];
      for (const m of cfg.models) {
        if (!list.includes(m)) list.push(m);
      }
      modelsByProvider.set(cfg.provider, list);
    }

    // 根据选中的 provider 填充 model 下拉菜单
    function updateModelOptions() {
      const selectedProvider = providerSelect.value;
      const models = modelsByProvider.get(selectedProvider) ?? [];

      modelSelect.innerHTML = "";
      if (models.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(无可用模型)";
        modelSelect.appendChild(opt);
      } else {
        for (const model of models) {
          const opt = document.createElement("option");
          opt.value = model;
          opt.textContent = model;
          modelSelect.appendChild(opt);
        }
        // 默认选中包含 doubao-seed-2-0-pro 的选项，否则选第一个
        const defaultIdx = models.findIndex((m) => m.includes("doubao-seed-2-0-pro"));
        modelSelect.value = defaultIdx >= 0 ? models[defaultIdx] : models[0];
      }
    }

    providerSelect.onchange = updateModelOptions;
    updateModelOptions();

    appendClientLog("INFO", `已加载 ${uniqueProviders.length} 个 provider、${validConfigs.length} 个模型到全局模型下拉菜单`);
  } catch (err) {
    appendClientLog("WARN", "获取可用模型失败，使用默认 doubao", err);
  }
}

installClientLogCapture();
appendClientLog("INFO", "首页已加载");
populateGlobalModelSelects();
renderRoleConfig();
renderClientLogs();
startServerLogPolling();
fetchActiveRooms();

