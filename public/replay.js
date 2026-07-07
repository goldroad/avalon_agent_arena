const $ = (id) => document.getElementById(id);

let gameData = null;       // 当前加载的完整对局数据
let timeline = [];         // 构建的事件时间线
let currentStep = -1;      // 当前回放到的步骤索引
let playing = false;       // 是否正在自动播放
let playTimer = null;      // 自动播放定时器

// ========== 工具函数 ==========

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function seatColor(seatNo) {
  const n = Number(seatNo) || 0;
  const hue = (n * 47) % 360;
  return `hsl(${hue} 75% 52%)`;
}

function avatarLabel(seatNo) {
  return String(seatNo ?? "?");
}

function createAvatar(seatNo) {
  const el = document.createElement("span");
  el.className = "avatar";
  el.style.background = seatColor(seatNo);
  el.textContent = avatarLabel(seatNo);
  return el;
}

function alignmentClass(a) {
  const s = String(a ?? "").toLowerCase();
  if (s === "good") return "alignment-good";
  if (s === "evil") return "alignment-evil";
  return "";
}

function alignmentText(a) {
  const s = String(a ?? "").toLowerCase();
  if (s === "good") return "好人";
  if (s === "evil") return "坏人";
  return s || "-";
}

function phaseLabel(phase) {
  const map = {
    team_proposal: "提名队伍",
    team_prevote_chat: "投票前公聊",
    team_vote: "队伍投票",
    quest_vote: "任务投票",
    assassination: "刺杀",
    game_over: "已结束",
    lobby: "等待开局"
  };
  return map[phase] ?? phase ?? "-";
}

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

function formatActionSummary(action) {
  if (!action) return "";
  const t = action.type;
  if (t === "say") return `发言: ${(action.text ?? "").slice(0, 80)}`;
  if (t === "propose_team") return `提名队伍：[${(action.team ?? []).join(", ")}]${action.reason ? ` | ${action.reason}` : ""}`;
  if (t === "vote_team") return `投票：${action.vote === "approve" ? "赞成" : "反对"}${action.reason ? ` | ${action.reason}` : ""}`;
  if (t === "quest_action") return `任务行动：${action.action === "success" ? "成功" : "失败"}`;
  if (t === "assassinate") return `刺杀目标：#${action.target}`;
  return JSON.stringify(action);
}

function normalizeChatText(text) {
  const raw = String(text ?? "");
  if (!raw.startsWith("阶段切换：")) return raw;
  const rest = raw.slice("阶段切换：".length);
  const parenIdx = rest.indexOf("（");
  const phaseRaw = (parenIdx >= 0 ? rest.slice(0, parenIdx) : rest).trim();
  const tailRaw = parenIdx >= 0 ? rest.slice(parenIdx) : "";
  return `阶段切换：${phaseLabel(phaseRaw)}${tailRaw}`;
}

// ========== 构建回放时间线 ==========

function buildTimeline(game) {
  const items = [];

  // 将chat和thinkingHistory合并为统一时间线
  // chat条目（system + public_chat）
  for (const c of game.chat ?? []) {
    items.push({
      ts: c.ts,
      kind: c.kind || "system",
      seatNo: c.seatNo,
      text: c.text ?? "",
      thinking: null,
      action: null,
      phase: null
    });
  }

  // thinkingHistory条目
  for (const t of game.thinkingHistory ?? []) {
    items.push({
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

  // 按时间排序，同时间thinking排前面
  items.sort((a, b) => {
    const cmp = String(a.ts).localeCompare(String(b.ts));
    if (cmp !== 0) return cmp;
    const order = { thinking: 0, public_chat: 1, system: 2 };
    return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
  });

  return items;
}

// ========== 渲染历史列表 ==========

async function loadHistoryList() {
  try {
    const res = await fetch("/api/rooms/history");
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    renderHistoryList(json.history ?? []);
  } catch (err) {
    console.error("加载历史列表失败", err);
    $("emptyState").style.display = "";
    $("historyList").innerHTML = "";
  }
}

function renderHistoryList(history) {
  const list = $("historyList");
  const empty = $("emptyState");
  $("historyCount").textContent = `共 ${history.length} 场对局`;

  // 按对局时间倒序排列（最新的在最前面）
  history.sort((a, b) => {
    const ta = a.createdAt ?? "";
    const tb = b.createdAt ?? "";
    return String(tb).localeCompare(String(ta));
  });

  if (history.length === 0) {
    list.innerHTML = "";
    empty.style.display = "";
    return;
  }
  empty.style.display = "none";
  list.innerHTML = "";

  for (const h of history) {
    const item = document.createElement("div");
    item.className = "history-item";

    const info = document.createElement("div");
    info.className = "history-info";

    const roomIdShort = (h.roomId ?? "").replace(/^room_/, "").slice(0, 8);
    const createdTime = h.createdAt ? new Date(h.createdAt).toLocaleString("zh-CN", { hour12: false }) : "-";

    const winnerClass = h.winner === "good" ? "good" : h.winner === "evil" ? "evil" : "draw";
    const winnerText = h.winner === "good" ? "好人胜利" : h.winner === "evil" ? "坏人胜利" : "未分胜负";

    const playerTags = (h.players ?? []).map((p) => {
      const cls = alignmentClass(p.alignment);
      return `<span class="${cls}" style="font-size:11px">#${p.seatNo}${p.role}</span>`;
    }).join(" ");

    info.innerHTML = `
      <div class="mono" style="font-size: 13px; color: #b0baff">room_${roomIdShort}...</div>
      <div class="history-meta">
        <span class="pill">${h.playerCount}人局</span>
        <span class="replay-result ${winnerClass}" style="font-size:12px; padding:2px 10px">${winnerText}</span>
        <span class="pill">S${h.scoreboard?.success ?? 0} / F${h.scoreboard?.fail ?? 0}</span>
        <span class="muted" style="font-size: 11px">${createdTime}</span>
      </div>
      <div style="margin-top: 4px; font-size: 11px; line-height: 1.8">${playerTags}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "history-actions";

    const viewBtn = document.createElement("button");
    viewBtn.textContent = "查看回放";
    viewBtn.style.fontSize = "12px";
    viewBtn.style.padding = "6px 14px";
    viewBtn.onclick = () => loadReplay(h.roomId);
    actions.appendChild(viewBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "删除";
    deleteBtn.style.fontSize = "12px";
    deleteBtn.style.padding = "6px 14px";
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`确定要删除该对局回放吗？\nroom: ${(h.roomId ?? "").slice(0, 16)}...`)) return;
      try {
        deleteBtn.disabled = true;
        deleteBtn.textContent = "删除中...";
        const res = await fetch(`/api/rooms/history/${h.roomId}`, { method: "DELETE" });
        const json = await res.json();
        if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
        loadHistoryList();
      } catch (err) {
        console.error("删除失败", err);
        alert("删除失败：" + (err.message ?? err));
        deleteBtn.disabled = false;
        deleteBtn.textContent = "删除";
      }
    };
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

// ========== 加载回放数据 ==========

async function loadReplay(roomId) {
  try {
    const res = await fetch(`/api/rooms/history/${roomId}`);
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);
    gameData = json.game;
    timeline = buildTimeline(gameData);
    currentStep = -1;
    playing = false;
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    showReplayView();
  } catch (err) {
    console.error("加载回放数据失败", err);
    alert("加载回放数据失败：" + (err.message ?? err));
  }
}

function showReplayView() {
  $("listView").style.display = "none";
  $("replayView").style.display = "";
  renderReplayHeader();
  renderPlayers();
  renderTimeline();
  renderScenario();
  updatePlayback();
  // 重置AI复盘
  $("aiReviewContent").style.display = "none";
  $("aiReviewLoading").style.display = "none";
  $("aiReviewEmpty").style.display = "";
}

function showListView() {
  $("listView").style.display = "";
  $("replayView").style.display = "none";
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  playing = false;
}

// ========== 渲染回放视图 ==========

function renderReplayHeader() {
  const g = gameData;
  $("replayTitle").textContent = `${g.playerCount} 人局`;

  const winnerClass = g.winner === "good" ? "good" : g.winner === "evil" ? "evil" : "draw";
  const winnerText = g.winner === "good" ? "好人胜利" : g.winner === "evil" ? "坏人胜利" : "未分胜负";
  const resultEl = $("replayResult");
  resultEl.textContent = winnerText;
  resultEl.className = `replay-result ${winnerClass}`;

  $("scorePill").textContent = `S${g.scoreboard?.success ?? 0} / F${g.scoreboard?.fail ?? 0}`;
  $("createdAtPill").textContent = g.createdAt ? new Date(g.createdAt).toLocaleString("zh-CN", { hour12: false }) : "";
}

function renderScenario() {
  $("scenarioBox").textContent = gameData.scenario ?? "-";
}

function renderPlayers() {
  const box = $("playersList");
  box.innerHTML = "";
  const players = gameData.players ?? {};
  for (const seatNo of gameData.seats ?? []) {
    const p = players[seatNo];
    if (!p) continue;

    const card = document.createElement("div");
    card.className = "player-card";
    card.dataset.seatNo = seatNo;

    const who = document.createElement("div");
    who.className = "who";
    const av = createAvatar(seatNo);
    who.appendChild(av);

    const nameSpan = document.createElement("span");
    nameSpan.textContent = `#${seatNo} ${p.agentName ?? p.humanName ?? ""}`;
    who.appendChild(nameSpan);

    const roleSpan = document.createElement("span");
    roleSpan.className = "pill";
    roleSpan.textContent = p.role ?? "-";
    who.appendChild(roleSpan);

    if (p.alignment) {
      const alignSpan = document.createElement("span");
      alignSpan.className = alignmentClass(p.alignment);
      alignSpan.textContent = alignmentText(p.alignment);
      who.appendChild(alignSpan);
    }

    card.appendChild(who);

    const detail = document.createElement("div");
    detail.className = "detail";
    const llmText = p.llm ? `${p.llm.provider}:${p.llm.model}` : (p.type === "human" ? "人类玩家" : "-");
    detail.textContent = `模型: ${llmText}`;
    card.appendChild(detail);

    box.appendChild(card);
  }
}

function renderTimeline() {
  const box = $("timeline");
  box.innerHTML = "";

  const seatMeta = gameData.players ?? {};

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const div = document.createElement("div");
    div.className = "event-item";
    div.dataset.index = i;

    // 头部
    const head = document.createElement("div");
    head.className = "event-head";

    if (item.seatNo) {
      const av = createAvatar(item.seatNo);
      av.style.width = "22px";
      av.style.height = "22px";
      av.style.fontSize = "10px";
      head.appendChild(av);

      const who = document.createElement("span");
      who.className = "who";
      const p = seatMeta[item.seatNo];
      if (p) {
        const parts = [`#${item.seatNo}`];
        if (p.role) parts.push(p.role);
        if (p.alignment) parts.push(alignmentText(p.alignment));
        who.textContent = parts.join(" ");
        who.classList.add(alignmentClass(p.alignment));
      } else {
        who.textContent = `#${item.seatNo}`;
      }
      head.appendChild(who);
    } else {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = "系统";
      head.appendChild(who);
    }

    // thinking标签
    if (item.kind === "thinking" && item.phase) {
      const tag = document.createElement("span");
      tag.className = "phase-tag";
      tag.textContent = actionTypeLabel(item.phase);
      head.appendChild(tag);
    }

    const ts = document.createElement("span");
    ts.className = "mono muted";
    ts.style.fontSize = "10px";
    ts.style.marginLeft = "auto";
    ts.textContent = item.ts ? new Date(item.ts).toLocaleTimeString("zh-CN", { hour12: false }) : "";
    head.appendChild(ts);

    div.appendChild(head);

    // 内容
    if (item.kind === "thinking") {
      // fallback 提示
      if (item.modelMeta?.fallbackUsed) {
        const fbDiv = document.createElement("div");
        fbDiv.className = "thinking-box";
        fbDiv.style.color = "#e67e22";
        fbDiv.style.fontSize = "12px";
        fbDiv.textContent = `⚠ 原始模型 ${item.modelMeta.originalProvider} 调用失败 (${item.modelMeta.originalError ?? "未知错误"})，已自动切换为 ${item.modelMeta.fallbackProvider ?? "全局模型"}`;
        div.appendChild(fbDiv);
      }
      if (item.thinking) {
        const body = document.createElement("div");
        body.className = "thinking-box";
        body.textContent = `[思考过程] ${item.thinking}`;
        div.appendChild(body);
      }
      if (item.action) {
        const summary = formatActionSummary(item.action);
        if (summary) {
          const actionDiv = document.createElement("div");
          actionDiv.className = "action-box";
          actionDiv.textContent = summary;
          div.appendChild(actionDiv);
        }
      }
    } else {
      const body = document.createElement("div");
      body.className = "event-body";
      body.textContent = normalizeChatText(item.text);
      div.appendChild(body);
    }

    box.appendChild(div);
  }
}

// ========== 播放控制 ==========

function updatePlayback() {
  const total = timeline.length;
  const showThinking = $("autoThinking").checked;

  // 更新进度
  const displayStep = currentStep < 0 ? 0 : currentStep + 1;
  $("progressLabel").textContent = `${displayStep} / ${total}`;
  const pct = total > 0 ? (displayStep / total) * 100 : 0;
  $("progressFill").style.width = `${pct}%`;

  // 更新按钮状态
  $("playBtn").textContent = playing ? "⏸" : "▶";
  $("playBtn").classList.toggle("active", playing);
  $("playBtnLabel").textContent = playing ? "暂停" : "播放";
  $("stepBackBtn").disabled = currentStep < 0;
  $("stepForwardBtn").disabled = currentStep >= total - 1;

  // 更新时间线可见性
  const items = document.querySelectorAll("#timeline .event-item");
  for (const el of items) {
    const idx = Number(el.dataset.index);
    const isVisible = idx <= currentStep;
    const isCurrent = idx === currentStep;
    const isThinking = timeline[idx]?.kind === "thinking";

    el.classList.toggle("visible", isVisible);
    el.classList.toggle("current", isCurrent);

    // 思考过程的显示/隐藏
    if (isThinking) {
      el.style.display = (showThinking && isVisible) ? "" : (isVisible && !showThinking) ? "none" : "";
      if (!showThinking && isVisible) el.style.display = "none";
      if (!isVisible) el.style.display = "";
    }
  }

  // 高亮当前活跃玩家
  const currentPlayerSeatNo = currentStep >= 0 ? timeline[currentStep]?.seatNo : null;
  const playerCards = document.querySelectorAll("#playersList .player-card");
  for (const card of playerCards) {
    card.classList.toggle("active", String(card.dataset.seatNo) === String(currentPlayerSeatNo));
  }

  // 滚动到当前位置（仅在启用自动滚动时）
  const autoScroll = $("autoScroll").checked;
  if (autoScroll && currentStep >= 0) {
    const currentEl = document.querySelector(`#timeline .event-item[data-index="${currentStep}"]`);
    const timelinePanel = document.querySelector('.timeline-panel');
    if (currentEl && timelinePanel) {
      // 计算元素相对于时间线面板的位置
      const panelRect = timelinePanel.getBoundingClientRect();
      const elRect = currentEl.getBoundingClientRect();
      const isVisible = elRect.top >= panelRect.top && elRect.bottom <= panelRect.bottom;
      
      // 仅在元素不在可视区域内时才滚动
      if (!isVisible) {
        const scrollTop = timelinePanel.scrollTop + (elRect.top - panelRect.top) - (panelRect.height / 3);
        timelinePanel.scrollTo({ top: scrollTop, behavior: 'smooth' });
      }
    }
  }
}

function stepForward() {
  if (currentStep < timeline.length - 1) {
    currentStep++;
    updatePlayback();
  } else {
    stopPlaying();
  }
}

function stepBack() {
  if (currentStep >= 0) {
    currentStep--;
    updatePlayback();
  }
}

function goToStart() {
  currentStep = -1;
  updatePlayback();
}

function goToEnd() {
  currentStep = timeline.length - 1;
  updatePlayback();
}

function startPlaying() {
  if (playing) return;
  playing = true;
  const speed = Number($("speedSelect").value) || 1000;
  playTimer = setInterval(() => {
    if (currentStep < timeline.length - 1) {
      stepForward();
    } else {
      stopPlaying();
    }
  }, speed);
  updatePlayback();
}

function stopPlaying() {
  playing = false;
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  updatePlayback();
}

function togglePlay() {
  if (playing) stopPlaying();
  else startPlaying();
}

// ========== AI复盘 ==========

async function requestAiReview() {
  if (!gameData) return;
  $("aiReviewBtn").disabled = true;
  $("aiReviewBtn").textContent = "分析中...";
  $("aiReviewEmpty").style.display = "none";
  $("aiReviewContent").style.display = "none";
  $("aiReviewLoading").style.display = "";

  try {
    const res = await fetch(`/api/rooms/history/${gameData.roomId}/ai-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${res.status}`);

    $("aiReviewContent").textContent = json.review ?? "(无分析结果)";
    $("aiReviewContent").style.display = "";
    $("aiReviewLoading").style.display = "none";
  } catch (err) {
    console.error("AI复盘失败", err);
    $("aiReviewContent").textContent = `AI复盘失败: ${err.message ?? err}`;
    $("aiReviewContent").style.display = "";
    $("aiReviewLoading").style.display = "none";
  } finally {
    $("aiReviewBtn").disabled = false;
    $("aiReviewBtn").textContent = "AI 复盘本局";
  }
}

// ========== 事件绑定 ==========

$("backBtn").onclick = showListView;
$("playBtn").onclick = togglePlay;
$("stepBackBtn").onclick = stepBack;
$("stepForwardBtn").onclick = stepForward;
$("goEndBtn").onclick = goToEnd;
$("aiReviewBtn").onclick = requestAiReview;

$("speedSelect").onchange = () => {
  if (playing) {
    stopPlaying();
    startPlaying();
  }
};

$("autoThinking").onchange = () => {
  updatePlayback();
};

$("autoScroll").onchange = () => {
  // 仅在启用时立即滚动到当前位置
  if ($("autoScroll").checked) {
    updatePlayback();
  }
};

// 进度条点击跳转
$("progressBar").onclick = (e) => {
  const bar = $("progressBar");
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const targetStep = Math.round(ratio * (timeline.length - 1));
  currentStep = Math.max(-1, Math.min(timeline.length - 1, targetStep - 1));
  updatePlayback();
};

// 键盘快捷键
document.addEventListener("keydown", (e) => {
  if ($("replayView").style.display === "none") return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
  if (e.key === "ArrowLeft" || e.key === "j") { e.preventDefault(); stepBack(); }
  if (e.key === "ArrowRight" || e.key === "l") { e.preventDefault(); stepForward(); }
  if (e.key === "Home") { e.preventDefault(); goToStart(); }
  if (e.key === "End") { e.preventDefault(); goToEnd(); }
});

// ========== 初始化 ==========

loadHistoryList();

// ========== 播放控制栏悬浮逻辑 ==========
(function initFloatingControls() {
  const controls = document.querySelector('.playback-controls');
  if (!controls) return;

  // 创建占位元素，防止悬浮时页面跳动
  const placeholder = document.createElement('div');
  placeholder.style.display = 'none';
  placeholder.style.height = controls.offsetHeight + 'px';
  controls.parentNode.insertBefore(placeholder, controls.nextSibling);

  // 记录上一次的悬浮状态，避免不必要的更新
  let wasFloating = false;

  const check = () => {
    const rect = controls.getBoundingClientRect();
    const isFloating = rect.top < 0;
    
    if (isFloating !== wasFloating) {
      controls.classList.toggle('floating', isFloating);
      placeholder.style.display = isFloating ? 'block' : 'none';
      
      // 切换到悬浮时，更新占位元素高度
      if (isFloating) {
        placeholder.style.height = controls.offsetHeight + 'px';
      }
      
      wasFloating = isFloating;
    }
  };

  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', () => {
    // 窗口大小变化时更新占位高度
    if (wasFloating) {
      placeholder.style.height = controls.offsetHeight + 'px';
    }
    check();
  }, { passive: true });
  check();
})();
