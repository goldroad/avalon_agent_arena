const $ = (id) => document.getElementById(id);

let ws = null;
let current = { roomId: null, token: null, view: null };

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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeAlignment(alignment) {
  const raw = String(alignment ?? "").trim();
  if (!raw) return null;
  const a = raw.toLowerCase();
  if (a === "good") return { text: "Good", className: "alignment-good" };
  if (a === "evil") return { text: "evil", className: "alignment-evil" };
  return { text: raw, className: "" };
}

function createAlignmentSpan(alignment) {
  const norm = normalizeAlignment(alignment);
  if (!norm) return null;
  const el = document.createElement("span");
  if (norm.className) el.className = norm.className;
  el.textContent = norm.text;
  return el;
}

function setWhoWithMeta(whoEl, seatNo, metaParts) {
  whoEl.textContent = "";
  whoEl.appendChild(document.createTextNode(`玩家 ${seatNo}`));
  if (!metaParts || metaParts.length === 0) return;
  whoEl.appendChild(document.createTextNode("（"));
  for (let i = 0; i < metaParts.length; i += 1) {
    const part = metaParts[i];
    if (i) whoEl.appendChild(document.createTextNode(" / "));
    if (part && part.kind === "alignment") {
      const span = createAlignmentSpan(part.value);
      if (span) whoEl.appendChild(span);
      else whoEl.appendChild(document.createTextNode(String(part.value ?? "")));
    } else {
      whoEl.appendChild(document.createTextNode(String(part ?? "")));
    }
  }
  whoEl.appendChild(document.createTextNode("）"));
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function seatColor(seatNo) {
  const n = clampInt(seatNo, 0, 999, 0);
  const hue = (n * 47) % 360;
  return `hsl(${hue} 75% 52%)`;
}

function avatarLabelFor(seatNo) {
  const n = clampInt(seatNo, 0, 999, 0);
  if (!n) return "S";
  return String(n);
}

function createAvatar(seatNo, small = false) {
  const el = document.createElement("span");
  el.className = small ? "avatar small" : "avatar";
  el.style.background = seatColor(seatNo);
  el.textContent = avatarLabelFor(seatNo);
  return el;
}

function resolveViewer(view) {
  const kind = view?.viewer?.kind ?? null;
  const seatNo = view?.viewer?.seatNo ?? null;
  if (kind) return { kind, seatNo };

  const isGod = (view?.seats ?? []).filter((s) => Boolean(s.role)).length > 1;
  const isPlayer = Boolean(view?.privateInfo?.role);
  return { kind: isGod ? "god" : isPlayer ? "player" : "spectator", seatNo: isPlayer ? view?.privateInfo?.seatNo ?? null : null };
}

function renderSeats(view) {
  const grid = $("seatsGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const viewer = resolveViewer(view);
  const seats = view.seats ?? [];
  const countEl = $("seatsCount");
  if (countEl) countEl.textContent = `${seats.length} 人`;
  for (const s of view.seats ?? []) {
    const div = document.createElement("div");
    div.className = "seat-card";

    const top = document.createElement("div");
    top.className = "seat-top";
    top.appendChild(createAvatar(s.seatNo));

    const title = document.createElement("div");
    title.className = "seat-title";

    const who = document.createElement("span");
    who.className = "who";
    if (viewer.kind === "god") {
      const parts = [];
      if (s.role) parts.push(s.role);
      if (s.alignment) parts.push({ kind: "alignment", value: s.alignment });
      if (s.provider || s.model) parts.push(`${s.provider ?? "-"}:${s.model ?? "-"}`);
      setWhoWithMeta(who, s.seatNo, parts);
    } else {
      who.textContent = `玩家 ${s.seatNo}`;
    }
    title.appendChild(who);

    const typePill = document.createElement("span");
    typePill.className = "pill";
    typePill.textContent = s.type ?? "-";
    title.appendChild(typePill);

    top.appendChild(title);
    div.appendChild(top);

    const kv = document.createElement("div");
    kv.className = "kv";

    const name = s.humanName ?? s.agentName ?? null;
    if (name) {
      const line = document.createElement("div");
      line.className = "line";
      line.textContent = name;
      kv.appendChild(line);
    }

    if (viewer.kind !== "god") {
      if (s.role) {
        const line = document.createElement("div");
        line.className = "line";
        line.appendChild(document.createTextNode(`角色：${s.role}`));
        if (s.alignment) {
          line.appendChild(document.createTextNode("（"));
          const span = createAlignmentSpan(s.alignment);
          if (span) line.appendChild(span);
          else line.appendChild(document.createTextNode(String(s.alignment)));
          line.appendChild(document.createTextNode("）"));
        }
        kv.appendChild(line);
      }

      if (s.provider || s.model) {
        const line = document.createElement("div");
        line.className = "line";
        line.textContent = `模型：${s.provider ?? "-"} / ${s.model ?? "-"}`;
        kv.appendChild(line);
      }
    }

    if (kv.childNodes.length > 0) {
      div.appendChild(kv);
    }

    grid.appendChild(div);
  }
}

function renderChat(view) {
  const box = $("chatBox");
  if (!box) return;
  box.innerHTML = "";

  const viewer = resolveViewer(view);
  const seatMetaByNo = new Map((view.seats ?? []).map((s) => [s.seatNo, s]));

  // 合并 chat 和 thinkingHistory，按时间排序
  const timeline = [];

  // chat 条目（system + public_chat）
  for (const c of view.chat ?? []) {
    timeline.push({
      ts: c.ts,
      kind: c.kind || "system",
      seatNo: c.seatNo,
      text: c.text ?? "",
      thinking: null,
      action: null,
      phase: null
    });
  }

  // thinkingHistory 条目（仅上帝视角）
  if (viewer.kind === "god") {
    for (const t of view.thinkingHistory ?? []) {
      timeline.push({
        ts: t.ts,
        kind: "thinking",
        seatNo: t.seatNo,
        text: "",
        thinking: t.thinking,
        action: t.action,
        phase: t.phase,
        modelMeta: t.modelMeta ?? null
      });
    }
  }

  // 按时间排序，同时间 thinking 排在前面
  timeline.sort((a, b) => {
    const cmp = String(a.ts).localeCompare(String(b.ts));
    if (cmp !== 0) return cmp;
    const order = { thinking: 0, public_chat: 1, system: 2 };
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
  });

  for (const item of timeline) {
    const div = document.createElement("div");
    div.className = `timeline-item ${item.kind}`;

    // 头部
    const head = document.createElement("div");
    head.className = "timeline-head";
    head.appendChild(createAvatar(item.seatNo ?? 0, true));

    const who = document.createElement("span");
    who.className = "who";
    if (!item.seatNo) {
      who.textContent = "系统";
    } else if (viewer.kind === "god") {
      const s = seatMetaByNo.get(item.seatNo) ?? null;
      const parts = [];
      if (s?.role) parts.push(s.role);
      if (s?.alignment) parts.push({ kind: "alignment", value: s.alignment });
      if (s?.provider || s?.model) parts.push(`${s?.provider ?? "-"}:${s?.model ?? "-"}`);
      setWhoWithMeta(who, item.seatNo, parts);
    } else {
      who.textContent = `玩家 ${item.seatNo}`;
    }
    head.appendChild(who);

    // thinking 条目显示阶段标签
    if (item.kind === "thinking" && item.phase) {
      const phaseTag = document.createElement("span");
      phaseTag.className = "phase-tag";
      phaseTag.textContent = actionTypeLabel(item.phase);
      head.appendChild(phaseTag);
    }

    const ts = document.createElement("span");
    ts.className = "mono muted";
    ts.style.fontSize = "11px";
    ts.textContent = item.ts ?? "";
    head.appendChild(ts);

    div.appendChild(head);

    // 内容体
    if (item.kind === "thinking") {
      // fallback 提示
      if (item.modelMeta?.fallbackUsed) {
        const fbDiv = document.createElement("div");
        fbDiv.className = "thinking-body";
        fbDiv.style.color = "#e67e22";
        fbDiv.style.fontSize = "12px";
        // 根据是否是 provider 被禁用显示不同的提示信息
        if (item.modelMeta.providerDisabled) {
          fbDiv.textContent = `⚠ 原始模型 ${item.modelMeta.originalProvider} 已被禁用（连续失败 ${item.modelMeta.failureCount ?? 2} 次），已自动切换为 ${item.modelMeta.fallbackProvider ?? "全局模型"}`;
        } else {
          fbDiv.textContent = `⚠ 原始模型 ${item.modelMeta.originalProvider} 调用失败 (${item.modelMeta.originalError ?? "未知错误"})，已自动切换为 ${item.modelMeta.fallbackProvider ?? "全局模型"}`;
        }
        div.appendChild(fbDiv);
      }
      // 第一段：思考过程
      if (item.thinking) {
        const body = document.createElement("div");
        body.className = "thinking-body";
        body.textContent = `[思考过程] ${item.thinking}`;
        div.appendChild(body);
      }
      // 第二段：最终决策
      if (item.action) {
        const summary = formatActionSummary(item.action);
        if (summary) {
          const actionDiv = document.createElement("div");
          actionDiv.className = "thinking-action";
          actionDiv.textContent = summary;
          div.appendChild(actionDiv);
        }
      }
    } else {
      // 公聊/系统消息
      const body = document.createElement("div");
      body.className = "timeline-body";
      body.textContent = normalizeChatText(item.text);
      div.appendChild(body);
    }

    box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

/** action类型转中文标签 */
function actionTypeLabel(type) {
  const map = {
    say: "发言",
    propose_team: "提名",
    vote_team: "投票",
    quest_action: "任务",
    assassinate: "刺杀",
    fallback: "备用"
  };
  return map[type] ?? type ?? "-";
}

/** 格式化action摘要 */
function formatActionSummary(action) {
  if (!action) return "";
  const t = action.type;
  if (t === "say") return "";
  if (t === "propose_team") return `提名队伍：[${(action.team ?? []).join(", ")}]${action.reason ? ` | ${action.reason}` : ""}`;
  if (t === "vote_team") return `投票：${action.vote === "approve" ? "赞成" : "反对"}${action.reason ? ` | ${action.reason}` : ""}`;
  if (t === "quest_action") return `任务行动：${action.action === "success" ? "成功" : "失败"}`;
  if (t === "assassinate") return `刺杀目标：#${action.target}`;
  return JSON.stringify(action);
}

function setVisible(id, visible) {
  const el = $(id);
  if (!el) return;
  el.style.display = visible ? "" : "none";
}

function updateLayout(view) {
  const viewer = resolveViewer(view);
  const kind = viewer.kind;

  const appWrap = $("appWrap");
  if (appWrap) appWrap.classList.toggle("layout-god", kind === "god");

  // 直接控制上帝控制按钮的显示（因为按钮在header中，不在.wrap内）
  const godControls = $("godControls");
  if (godControls) godControls.style.display = kind === "god" ? "flex" : "none";

  const who = kind === "god" ? "上帝" : kind === "player" ? "玩家" : "路人";
  setPill("viewPill", who);
  setPill("seatPill", kind === "player" ? `座位：#${viewer.seatNo ?? ""}` : "座位：-");

  const canAct = kind === "player";
  setVisible("connectCard", canAct);
  setVisible("phaseCard", canAct);
  setVisible("actionCard", canAct);
  setVisible("chatInputRow", canAct);

  const chatInput = $("chatInput");
  const sendChatBtn = $("sendChatBtn");
  if (chatInput) chatInput.disabled = !canAct;
  if (sendChatBtn) sendChatBtn.disabled = !canAct;

  const proposeBtn = $("proposeBtn");
  const approveBtn = $("approveBtn");
  const rejectBtn = $("rejectBtn");
  const questSuccessBtn = $("questSuccessBtn");
  const questFailBtn = $("questFailBtn");
  const assassinateBtn = $("assassinateBtn");

  const isLeader = canAct && viewer.seatNo === (view?.leaderSeat ?? null);
  const onQuest = canAct && Array.isArray(view?.quest?.team) && view.quest.team.includes(viewer.seatNo);
  const isAssassin = canAct && view?.privateInfo?.role === "assassin";

  if (proposeBtn) proposeBtn.disabled = !isLeader || view?.phase !== "team_proposal";
  if (approveBtn) approveBtn.disabled = !canAct || view?.phase !== "team_vote";
  if (rejectBtn) rejectBtn.disabled = !canAct || view?.phase !== "team_vote";
  if (questSuccessBtn) questSuccessBtn.disabled = !onQuest || view?.phase !== "quest_vote";
  if (questFailBtn) questFailBtn.disabled = !onQuest || view?.phase !== "quest_vote";
  if (assassinateBtn) assassinateBtn.disabled = !isAssassin || view?.phase !== "assassination";
}

function phaseLabel(phase) {
  const p = String(phase ?? "");
  if (p === "lobby") return "等待开局";
  if (p === "team_proposal") return "提名队伍";
  if (p === "team_prevote_chat") return "投票前公聊";
  if (p === "team_vote") return "队伍投票";
  if (p === "quest_vote") return "任务投票";
  if (p === "assassination") return "刺杀";
  if (p === "game_over") return "已结束";
  return p || "-";
}

function normalizeChatText(text) {
  const raw = String(text ?? "");
  if (!raw) return raw;
  if (!raw.startsWith("阶段切换：")) return raw;
  const rest = raw.slice("阶段切换：".length);
  const parenIdx = rest.indexOf("（");
  const phaseRaw = (parenIdx >= 0 ? rest.slice(0, parenIdx) : rest).trim();
  const tailRaw = parenIdx >= 0 ? rest.slice(parenIdx) : "";
  const phaseZh = phaseLabel(phaseRaw);
  const tail = tailRaw.replaceAll("leader #", "队长 #");
  return `阶段切换：${phaseZh}${tail}`;
}

function formatPending(view) {
  const pending = view?.pending ?? null;
  if (!pending || !pending.type) return "";

  if (pending.type === "team_proposal") {
    const leader = pending.leaderSeat ?? view?.leaderSeat ?? null;
    const required = pending.requiredTeamSize ?? null;
    return `等待 #${leader} 提名队伍${required ? `（需要 ${required} 人）` : ""}`;
  }

  if (pending.type === "team_vote") {
    const remainingSeats = Array.isArray(pending.remainingSeats) ? pending.remainingSeats : null;
    const remainingCount = pending.remainingCount ?? null;
    if (remainingSeats && remainingSeats.length > 0) return `等待投票：${remainingSeats.map((x) => `#${x}`).join(", ")}`;
    if (typeof remainingCount === "number") return `等待投票：剩余 ${remainingCount} 人`;
    return "等待投票";
  }

  if (pending.type === "team_prevote_chat") {
    const remainingSeats = Array.isArray(pending.remainingSeats) ? pending.remainingSeats : null;
    const remainingCount = pending.remainingCount ?? null;
    if (remainingSeats && remainingSeats.length > 0) return `投票前公聊：等待 ${remainingSeats.map((x) => `#${x}`).join(", ")}`;
    if (typeof remainingCount === "number") return `投票前公聊：剩余 ${remainingCount} 人`;
    return "投票前公聊";
  }

  if (pending.type === "quest_vote") {
    const remainingSeats = Array.isArray(pending.remainingSeats) ? pending.remainingSeats : null;
    const team = Array.isArray(pending.team) ? pending.team : null;
    if (remainingSeats && remainingSeats.length > 0) return `等待任务提交：${remainingSeats.map((x) => `#${x}`).join(", ")}`;
    if (team && team.length > 0) return `等待任务提交：队伍 ${team.map((x) => `#${x}`).join(", ")}`;
    return "等待任务提交";
  }

  if (pending.type === "assassination") {
    const assassinSeat = pending.assassinSeat ?? null;
    return assassinSeat ? `等待刺客 #${assassinSeat} 刺杀目标` : "等待刺客刺杀目标";
  }

  if (pending.type === "game_over") {
    const w = pending.winner === "evil" ? "坏人" : pending.winner === "good" ? "好人" : pending.winner ? String(pending.winner) : "-";
    return `已结束：${w}胜利`;
  }

  return "";
}

function renderStatus(view) {
  const phaseEl = $("statusPhase");
  const leaderEl = $("statusLeader");
  const pendingEl = $("statusPending");
  if (phaseEl && leaderEl && pendingEl) {
    phaseEl.textContent = phaseLabel(view?.phase);
    leaderEl.textContent = `#${view?.leaderSeat ?? "-"}`;
    const pending = formatPending(view);
    pendingEl.textContent = pending || "-";
    return;
  }

  const line = $("statusLine");
  if (!line) return;
  const base = `${phaseLabel(view?.phase)}｜队长 #${view?.leaderSeat ?? "-"}`;
  const pending = formatPending(view);
  line.textContent = pending ? `${base}｜${pending}` : base;
}

function renderView(view) {
  current.view = view;
  setPill("roomPill", `房间：${view.roomId}`);
  setPill("phasePill", `阶段：${phaseLabel(view.phase)}`);
  setPill("leaderPill", `队长：#${view.leaderSeat}`);
  setPill("scorePill", `比分：S${view.scoreboard?.success ?? 0} / F${view.scoreboard?.fail ?? 0}（连续拒绝:${view.scoreboard?.rejectsInRow ?? 0}）`);

  // 总进度：已出征轮数、成功/失败次数、当前轮次/总轮数
  const totalQuests = view.questPlan?.sizes?.length ?? 5;
  const success = view.scoreboard?.success ?? 0;
  const fail = view.scoreboard?.fail ?? 0;
  const dispatched = success + fail;
  const questNo = view.questNo ?? 1;
  const rejectsInRow = view.scoreboard?.rejectsInRow ?? 0;
  setPill("progressPill",
    `总进度：第 ${questNo} / ${totalQuests} 轮｜已出征 ${dispatched} 轮｜成功 ${success} 次｜失败 ${fail} 次` +
    (rejectsInRow > 0 ? `｜连续拒绝 ${rejectsInRow} 次` : "")
  );

  setText("scenarioBox", view.scenario ?? "-");

  // 更新暂停按钮状态
  const pauseBtn = $("pauseBtn");
  if (pauseBtn) {
    const paused = Boolean(view.paused);
    pauseBtn.textContent = paused ? "恢复" : "暂停";
    pauseBtn.classList.toggle("active", paused);
  }

  // 游戏结束时禁用暂停按钮
  const endBtn = $("endBtn");
  if (endBtn) endBtn.disabled = view.phase === "game_over";
  if (pauseBtn) pauseBtn.disabled = view.phase === "game_over";

  updateLayout(view);
  renderStatus(view);

  renderSeats(view);
  renderChat(view);
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
  const viewer = resolveViewer(current.view);
  if (viewer.kind !== "player") return;
  await api(`/api/rooms/${roomId}/action`, { token, action });
}

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
  const reason = ($("reasonInput")?.value ?? "").trim();
  if ($("reasonInput")) $("reasonInput").value = "";
  await sendAction({ type: "propose_team", team, reason: reason || undefined });
};

$("approveBtn").onclick = async () => {
  const reason = ($("reasonInput")?.value ?? "").trim();
  if ($("reasonInput")) $("reasonInput").value = "";
  await sendAction({ type: "vote_team", vote: "approve", reason: reason || undefined });
};
$("rejectBtn").onclick = async () => {
  const reason = ($("reasonInput")?.value ?? "").trim();
  if ($("reasonInput")) $("reasonInput").value = "";
  await sendAction({ type: "vote_team", vote: "reject", reason: reason || undefined });
};
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

// === 玩家列表折叠/展开切换 ===
(function initSeatsToggle() {
  const toggle = $("seatsToggle");
  const grid = $("seatsGrid");
  const arrow = $("seatsArrow");
  const card = toggle?.closest(".seats-card");
  if (!toggle || !grid || !arrow) return;
  toggle.onclick = () => {
    const isCollapsed = grid.classList.toggle("collapsed");
    arrow.classList.toggle("open", !isCollapsed);
    if (card) card.classList.toggle("collapsed", isCollapsed);
  };
})();

// === 上帝控制按钮 ===
$("pauseBtn").onclick = async () => {
  const roomId = current.roomId;
  const token = current.token;
  if (!roomId || !token) return;
  try {
    await api(`/api/rooms/${roomId}/pause`, { token });
  } catch (err) {
    console.error("pause failed", err);
  }
};

$("endBtn").onclick = async () => {
  const roomId = current.roomId;
  const token = current.token;
  if (!roomId || !token) return;
  if (!confirm("确定要强制结束当前游戏吗？")) return;
  try {
    await api(`/api/rooms/${roomId}/end`, { token });
  } catch (err) {
    console.error("end failed", err);
  }
};

