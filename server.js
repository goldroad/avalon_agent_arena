/**
 * Avalon Agent Arena - 后端服务
 * 作者：无涯
 * Copyright (c) 2026 无涯. All rights reserved.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

const LOCAL_DIR = path.join(__dirname, ".local");
const LLM_CONFIG_PATH = path.join(LOCAL_DIR, "llm-config.json");
const HISTORY_DIR = path.join(LOCAL_DIR, "history");
const LOG_DIR = path.join(__dirname, "logs");
const SERVER_STDOUT_LOG_PATH = path.join(LOG_DIR, "server.out.log");
const SERVER_STDERR_LOG_PATH = path.join(LOG_DIR, "server.err.log");
const LLM_REQUEST_LOG_PATH = path.join(LOG_DIR, "llm-requests.log");
const roomLlmLogPaths = new Map();

function nowIso() {
  return new Date().toISOString();
}

function rid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function stableSortBySeat(seats) {
  return [...seats].sort((a, b) => a - b);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function pickQuestPlan(playerCount) {
  const plans = {
    5: { sizes: [2, 3, 2, 3, 3], fails: [1, 1, 1, 1, 1] },
    6: { sizes: [2, 3, 4, 3, 4], fails: [1, 1, 1, 1, 1] },
    7: { sizes: [2, 3, 3, 4, 4], fails: [1, 1, 1, 2, 1] },
    8: { sizes: [3, 4, 4, 5, 5], fails: [1, 1, 1, 2, 1] },
    9: { sizes: [3, 4, 4, 5, 5], fails: [1, 1, 1, 2, 1] },
    10: { sizes: [3, 4, 4, 5, 5], fails: [1, 1, 1, 2, 1] }
  };
  const p = plans[playerCount];
  if (!p) throw new Error(`Unsupported playerCount=${playerCount} (supported 5-10)`);
  return p;
}

function buildRoleDeck(playerCount) {
  const byCount = {
    5: ["merlin", "loyal", "loyal", "assassin", "morgana"],
    6: ["merlin", "percival", "loyal", "loyal", "assassin", "morgana"],
    7: ["merlin", "percival", "loyal", "loyal", "loyal", "assassin", "morgana"],
    8: ["merlin", "percival", "loyal", "loyal", "loyal", "assassin", "morgana", "minion"],
    9: ["merlin", "percival", "loyal", "loyal", "loyal", "loyal", "assassin", "morgana", "minion"],
    10: ["merlin", "percival", "loyal", "loyal", "loyal", "loyal", "loyal", "assassin", "morgana", "minion"]
  };
  const deck = byCount[playerCount];
  if (!deck) throw new Error(`Unsupported playerCount=${playerCount} (supported 5-10)`);
  return [...deck];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function roleAlignment(role) {
  switch (role) {
    case "merlin":
    case "percival":
    case "loyal":
      return "good";
    case "assassin":
    case "morgana":
    case "minion":
      return "evil";
    default:
      return "unknown";
  }
}

function roleDisplayName(role) {
  const map = {
    merlin: "Merlin",
    percival: "Percival",
    loyal: "Loyal Servant",
    assassin: "Assassin",
    morgana: "Morgana",
    minion: "Minion of Mordred"
  };
  return map[role] ?? role;
}

function defaultScenario() {
  const pool = [
    "目标：好人阵营要尽量在不暴露梅林的情况下建立可信联盟并完成3次任务成功；坏人阵营要通过欺骗与结盟破坏任务并在终局刺杀梅林。",
    "目标：测试长记忆与结盟行为——每位玩家需要持续维护自己的联盟承诺并在关键轮次做一致决策。",
    "目标：欺骗博弈演示——坏人需要制造可解释的投票模式，好人需要用证据链推理而非情绪判断。 "
  ];
  return pool[crypto.randomInt(0, pool.length)];
}

function normalizeProviderName(v) {
  if (!v) return "custom";
  const s = String(v).trim().toLowerCase();
  const allowed = new Set(["deepseek", "xiaomi", "aliyun", "doubao", "kimi", "custom"]);
  if (allowed.has(s)) return s;
  // 自定义 provider：仅允许字母、数字、短横线、下划线
  if (/^[a-z0-9][a-z0-9\-_]{2,49}$/.test(s)) return s;
  return "custom";
}

function ensureLocalDir() {
  try {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
  } catch {}
}

function loadLlmConfig() {
  try {
    ensureLocalDir();
    if (!fs.existsSync(LLM_CONFIG_PATH)) return {};
    const raw = fs.readFileSync(LLM_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      const p = normalizeProviderName(k);
      if (!v || typeof v !== "object") continue;
      const baseUrl = typeof v.baseUrl === "string" ? v.baseUrl.trim() : "";
      const apiKey = typeof v.apiKey === "string" ? v.apiKey.trim() : "";
      const model = typeof v.model === "string" ? v.model.trim() : "";
      if (!baseUrl && !apiKey && !model) continue;
      const models = Array.isArray(v.models) ? v.models.filter((m) => typeof m === "string" && m.trim().length > 0).map((m) => m.trim()) : [];
      out[p] = {
        baseUrl: baseUrl || null,
        apiKey: apiKey || null,
        model: model || null,
        models,
        timeoutMs: typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs) ? v.timeoutMs : null
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveLlmConfig(store) {
  ensureLocalDir();
  const safe = {};
  for (const [k, v] of Object.entries(store ?? {})) {
    const p = normalizeProviderName(k);
    if (!v || typeof v !== "object") continue;
    safe[p] = {
      baseUrl: v.baseUrl ?? null,
      apiKey: v.apiKey ?? null,
      model: v.model ?? null,
      timeoutMs: typeof v.timeoutMs === "number" && Number.isFinite(v.timeoutMs) ? v.timeoutMs : null
    };
  }
  fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(safe, null, 2), "utf8");
}

const llmConfigStore = loadLlmConfig();

function normalizeRoleName(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  const allowed = new Set(["merlin", "percival", "loyal", "assassin", "morgana", "minion"]);
  if (!allowed.has(s)) return null;
  return s;
}

function normalizeRoleLlmMap(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const role = normalizeRoleName(k);
    if (!role || !v || typeof v !== "object") continue;
    const provider = normalizeProviderName(v.provider);
    const model = typeof v.model === "string" && v.model.trim().length > 0 ? v.model.trim() : null;
    const temperature = typeof v.temperature === "number" && Number.isFinite(v.temperature) ? v.temperature : 0.6;
    out[role] = { provider, model, temperature };
  }

  const roleKeys = Object.keys(out);
  if (roleKeys.length === 0) return null;

  return out;
}

function providerEnv(provider) {
  const p = normalizeProviderName(provider);
  const prefix = p.toUpperCase();
  const stored = llmConfigStore[p] ?? null;
  return {
    baseUrl: stored?.baseUrl ?? (process.env[`${prefix}_BASE_URL`] ?? process.env.LLM_BASE_URL),
    apiKey: stored?.apiKey ?? (process.env[`${prefix}_API_KEY`] ?? process.env.LLM_API_KEY),
    model: stored?.model ?? (process.env[`${prefix}_MODEL`] ?? process.env.LLM_MODEL)
  };
}

function resolveChatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim();
  if (!raw) return "";

  if (/\/chat\/completions\/?$/i.test(raw) || /\/v1\/chat\/completions\/?$/i.test(raw)) {
    return raw;
  }

  if (/\/api\/v3\/?$/i.test(raw) || /\/v1\/?$/i.test(raw)) {
    return new URL("./chat/completions", raw.endsWith("/") ? raw : `${raw}/`).toString();
  }

  return new URL("/v1/chat/completions", raw).toString();
}

function resolveTemperature(provider, model, temperature) {
  const p = normalizeProviderName(provider);
  const m = String(model ?? "").trim().toLowerCase();
  if (p === "kimi" && m === "kimi-k2.6") {
    return 1;
  }
  return typeof temperature === "number" ? temperature : 0.6;
}

/**
 * 将 LLM 请求/响应详情写入 logs/llm-requests.log
 * 每条记录为一个 JSON 行（JSONL 格式），便于后续分析
 */
function logLLMRequest(entry) {
  try {
    const roomId = entry?.roomId;
    const logPath = (roomId && roomLlmLogPaths.has(roomId)) 
      ? roomLlmLogPaths.get(roomId) 
      : LLM_REQUEST_LOG_PATH;

    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * 截断字符串到指定长度，超出部分用 ... 替代
 */
function truncateStr(s, maxLen) {
  if (typeof s !== "string") return String(s ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

/**
 * 获取 provider 级别的超时配置。
 * 优先级：provider 配置的 timeoutMs > 环境变量 LLM_TIMEOUT_MS > 默认 60000ms
 */
function getProviderTimeoutMs(provider) {
  const p = normalizeProviderName(provider);
  const stored = llmConfigStore[p];
  if (stored && typeof stored.timeoutMs === "number" && Number.isFinite(stored.timeoutMs)) {
    return clampInt(stored.timeoutMs, 1000, 300000, 60000);
  }
  return clampInt(process.env.LLM_TIMEOUT_MS, 1000, 300000, 60000);
}

async function llmChat({ provider, model, messages, temperature, roomId }) {
  const env = providerEnv(provider);
  const baseUrl = env.baseUrl;
  const apiKey = env.apiKey;
  const chosenModel = model ?? env.model;
  if (!baseUrl || !apiKey || !chosenModel) {
    return {
      ok: false,
      text: "",
      usage: null,
      raw: { error: "LLM not configured (missing *_BASE_URL / *_API_KEY / *_MODEL env vars)" }
    };
  }

  const url = resolveChatCompletionsUrl(baseUrl);
  const timeoutMs = getProviderTimeoutMs(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // 统计输入 token 估算（粗略：按字符数 / 3 估算）
  const messagesJson = JSON.stringify(messages);
  const inputCharCount = messagesJson.length;
  const inputTokenEstimate = Math.ceil(inputCharCount / 3);

  const requestId = rid("llm");
  const startedAt = nowIso();
  const startTimeMs = Date.now();

  // 记录请求发起
  logLLMRequest({
    requestId,
    phase: "request",
    ts: startedAt,
    provider,
    model: chosenModel,
    url,
    temperature: resolveTemperature(provider, chosenModel, temperature),
    timeoutMs,
    messageCount: messages.length,
    inputCharCount,
    inputTokenEstimate,
    systemPromptPreview: truncateStr(messages.find(m => m.role === "system")?.content ?? "", 200),
    userPromptPreview: truncateStr(messages.find(m => m.role === "user")?.content ?? "", 500),
    roomId: roomId ?? null
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: chosenModel,
        temperature: resolveTemperature(provider, chosenModel, temperature),
        messages
      }),
      signal: controller.signal
    });

    const raw = await res.json().catch(() => ({}));
    const text = raw?.choices?.[0]?.message?.content ?? "";
    const usage = raw?.usage ?? null;
    const elapsedMs = Date.now() - startTimeMs;

    // 记录响应
    logLLMRequest({
      requestId,
      phase: "response",
      ts: nowIso(),
      provider,
      model: chosenModel,
      httpStatus: res.status,
      ok: res.ok,
      elapsedMs,
      outputLength: text.length,
      usage,
      responsePreview: truncateStr(text, 300),
      error: res.ok ? null : (raw?.error?.message ?? raw?.error ?? "http_error"),
      roomId: roomId ?? null
    });

    return { ok: res.ok, text, usage, raw };
  } catch (err) {
    const isTimeout = err?.name === "AbortError";
    const elapsedMs = Date.now() - startTimeMs;
    const errorMsg = isTimeout ? `timeout_after_${timeoutMs}ms` : String(err?.message ?? err);

    // 记录错误
    logLLMRequest({
      requestId,
      phase: "error",
      ts: nowIso(),
      provider,
      model: chosenModel,
      elapsedMs,
      isTimeout,
      error: errorMsg,
      roomId: roomId ?? null
    });

    return { ok: false, text: "", usage: null, raw: { error: errorMsg } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判断 LLM 调用是否因为 API 不可用（额度耗尽、限流、服务端错误等）而失败。
 * 排除 "未配置" 类错误——如果连配置都没有，fallback 到全局模型也可能没配置。
 */
function isApiFailure(result) {
  if (!result || result.ok) return false;
  const err = String(result.raw?.error ?? "").toLowerCase();
  // 未配置不算 API 故障，不触发 fallback
  if (err.includes("not configured") || err.includes("missing")) return false;
  // 其他错误（timeout、HTTP 错误、解析错误等）视为 API 故障
  return true;
}

/**
 * Provider 连续失败计数器
 * key: provider 名称, value: 连续失败次数
 * 当连续失败达到 MAX_CONSECUTIVE_FAILURES 次时，自动跳过该 provider
 */
const providerFailureCounts = new Map();
const MAX_CONSECUTIVE_FAILURES = 2;

/**
 * 检查 provider 是否已被标记为不可用（连续失败次数达到上限）
 */
function isProviderDisabled(provider) {
  const p = normalizeProviderName(provider);
  const count = providerFailureCounts.get(p) ?? 0;
  return count >= MAX_CONSECUTIVE_FAILURES;
}

/**
 * 记录 provider 失败
 */
function recordProviderFailure(provider) {
  const p = normalizeProviderName(provider);
  const count = (providerFailureCounts.get(p) ?? 0) + 1;
  providerFailureCounts.set(p, count);
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(`[llm-failure] provider=${p} 连续失败 ${count} 次，已自动禁用，后续请求将直接使用 fallback`);
  }
  return count;
}

/**
 * 重置 provider 失败计数（成功调用时调用）
 */
function resetProviderFailure(provider) {
  const p = normalizeProviderName(provider);
  if (providerFailureCounts.has(p)) {
    providerFailureCounts.delete(p);
    console.log(`[llm-failure] provider=${p} 调用成功，已重置失败计数`);
  }
}

/**
 * 获取所有 provider 的失败状态（供前端展示）
 */
function getProviderFailureStatus() {
  const status = {};
  for (const [provider, count] of providerFailureCounts.entries()) {
    status[provider] = { failureCount: count, disabled: count >= MAX_CONSECUTIVE_FAILURES };
  }
  return status;
}

/**
 * 带自动 fallback 的 LLM 调用。
 * 先用指定 provider 调用，如果失败（额度耗尽、限流、超时等），自动切换到全局模型重试。
 * 如果 provider 连续失败达到上限，直接跳过使用全局模型。
 * 返回值比 llmChat 多一个 fallbackUsed / fallbackProvider 字段。
 */
async function llmChatWithFallback({ provider, model, messages, temperature, fallbackProvider, fallbackModel, roomId }) {
  const normalizedProvider = normalizeProviderName(provider);
  const fbProvider = normalizeProviderName(fallbackProvider || "custom");
  const fbModel = fallbackModel || null;

  // 检查 provider 是否已被禁用（连续失败达到上限）
  if (isProviderDisabled(normalizedProvider) && normalizedProvider !== fbProvider) {
    const failureCount = providerFailureCounts.get(normalizedProvider) ?? 0;
    console.warn(`[llm-fallback] provider=${provider} 已被禁用（连续失败 ${failureCount} 次），直接使用全局模型 ${fbProvider}`);
    
    // 检查全局模型是否已配置
    const fbEnv = providerEnv(fbProvider);
    if (!fbEnv.baseUrl || !fbEnv.apiKey || !fbEnv.model) {
      console.warn(`[llm-fallback] 全局模型 ${fbProvider} not configured, giving up fallback`);
      return {
        ok: false,
        text: "",
        usage: null,
        raw: { error: `provider=${provider} 已被禁用（连续失败 ${failureCount} 次），且全局模型 ${fbProvider} 未配置` },
        fallbackUsed: false,
        providerDisabled: true,
        failureCount
      };
    }

    // 直接用全局模型
    const fbResult = await llmChat({
      provider: fbProvider,
      model: fbModel,
      messages,
      temperature,
      roomId
    }).catch((err) => ({
      ok: false,
      text: "",
      usage: null,
      raw: { error: String(err?.message ?? err) }
    }));

    if (fbResult.ok) {
      console.log(`[llm-fallback] 全局模型 ${fbProvider} 直接调用成功（跳过已禁用的 ${provider}）`);
    } else {
      console.warn(`[llm-fallback] 全局模型 ${fbProvider} 调用也失败: ${fbResult.raw?.error}`);
    }

    return { 
      ...fbResult, 
      fallbackUsed: true, 
      fallbackProvider: fbProvider,
      originalProvider: provider, 
      originalError: `provider 已被禁用（连续失败 ${failureCount} 次）`,
      providerDisabled: true,
      failureCount
    };
  }

  // 正常调用指定 provider
  const result = await llmChat({ provider, model, messages, temperature, roomId }).catch((err) => ({
    ok: false,
    text: "",
    usage: null,
    raw: { error: String(err?.message ?? err) }
  }));

  // 如果成功，重置失败计数
  if (result.ok) {
    resetProviderFailure(normalizedProvider);
    return { ...result, fallbackUsed: false };
  }

  // 如果已经是全局模型，直接返回（避免死循环）
  if (normalizedProvider === fbProvider) {
    return { ...result, fallbackUsed: false };
  }

  // 判断是否为 API 故障（非配置缺失类错误）
  if (!isApiFailure(result)) {
    return { ...result, fallbackUsed: false };
  }

  // 记录失败次数
  const failureCount = recordProviderFailure(normalizedProvider);
  const originalError = result.raw?.error ?? "unknown_error";
  console.warn(`[llm-fallback] provider=${provider} failed (${originalError})，连续失败 ${failureCount} 次`);

  // 检查全局模型是否已配置
  const fbEnv = providerEnv(fbProvider);
  if (!fbEnv.baseUrl || !fbEnv.apiKey || !fbEnv.model) {
    console.warn(`[llm-fallback] 全局模型 ${fbProvider} not configured, giving up fallback`);
    return { ...result, fallbackUsed: false };
  }

  // 用全局模型重试
  const fbResult = await llmChat({
    provider: fbProvider,
    model: fbModel,
    messages,
    temperature,
    roomId
  }).catch((err) => ({
    ok: false,
    text: "",
    usage: null,
    raw: { error: String(err?.message ?? err) }
  }));

  if (fbResult.ok) {
    console.log(`[llm-fallback] 全局模型 ${fbProvider} fallback succeeded`);
  } else {
    console.warn(`[llm-fallback] 全局模型 ${fbProvider} fallback also failed: ${fbResult.raw?.error}`);
  }

  return { 
    ...fbResult, 
    fallbackUsed: true, 
    fallbackProvider: fbProvider,
    originalProvider: provider, 
    originalError,
    failureCount
  };
}

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false, value: null };
  }
}

function phaseLabelZh(phase) {
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

function pickFallbackAction(ctx) {
  const { phase, requiredTeamSize, seatNo, playerCount } = ctx;
  if (phase === "team_proposal") {
    const seats = [];
    while (seats.length < requiredTeamSize) {
      const s = 1 + crypto.randomInt(0, playerCount);
      if (!seats.includes(s)) seats.push(s);
    }
    if (!seats.includes(seatNo)) {
      seats[0] = seatNo;
    }
    return {
      type: "propose_team",
      team: stableSortBySeat(seats),
      reason: "当前信息不足，我倾向用这支队伍来快速验证各位的站位与投票倾向。"
    };
  }
  if (phase === "team_prevote_chat") {
    return { type: "say", text: "我对这支队伍暂时持保留态度，想看大家投票与后续任务表现再下结论。" };
  }
  if (phase === "team_vote") {
    const vote = crypto.randomInt(0, 2) === 0 ? "approve" : "reject";
    return {
      type: "vote_team",
      vote,
      reason: vote === "approve" ? "这队目前看起来风险可控，先过一把拿信息。" : "这队结构有风险，我更希望换队再看。"
    };
  }
  if (phase === "quest_vote") {
    return { type: "quest_action", action: "success" };
  }
  if (phase === "assassination") {
    const target = 1 + crypto.randomInt(0, playerCount);
    return { type: "assassinate", target };
  }
  return { type: "noop" };
}

function buildAgentPrompt({ view, privateInfo, agentMemory, scenario }) {
  // 精简后的系统提示词，减少Token消耗
  const system = `你是阿瓦隆AI玩家。输出严格JSON，不要多余文本。
不要泄露隐藏信息（除非角色允许或自曝）。
目标：根据阵营最大化胜率。

输出格式：{"thinking":"思考过程","action":{...}}
thinking: 分析队伍/局势、身份推理、投票理由、策略考量
action: 最终决策

可用action类型：
- team_prevote_chat: {"type":"say","text":"..."}
- team_proposal: {"type":"propose_team","team":[1,2,...],"reason":"一句话"}
- team_vote: {"type":"vote_team","vote":"approve/reject","reason":"一句话"}
- quest_vote: {"type":"quest_action","action":"success/fail"}
- assassination: {"type":"assassinate","target":数字}`;

  // 压缩记忆数据：只保留最近的关键信息
  const compressedMemory = compressAgentMemory(agentMemory);
  
  // 压缩visible_state：只传递当前阶段必要的信息
  const compressedView = compressVisibleState(view);

  const user = {
    scenario,
    visible_state: compressedView,
    private_info: privateInfo,
    memory: compressedMemory
  };

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(user) }
    ]
  };
}

/**
 * 压缩visible_state，只传递AI玩家在当前阶段需要的信息
 * 大幅减少Token消耗
 */
function compressVisibleState(view) {
  if (!view) return {};

  const phase = view.phase;
  const compressed = {
    phase,
    playerCount: view.playerCount,
    leader: view.leaderSeat,
    score: view.scoreboard
  };

  // 根据不同阶段传递不同的信息
  if (phase === "team_proposal") {
    // 提名阶段：只需要知道需要多少人
    compressed.requiredTeamSize = view.pending?.requiredTeamSize ?? 0;
    compressed.history = compressHistory(view.history?.proposals ?? [], 3);
  } else if (phase === "team_prevote_chat") {
    // 投票前公聊：需要知道提名的队伍
    compressed.proposal = view.proposal;
    compressed.history = compressHistory(view.history?.proposals ?? [], 3);
  } else if (phase === "team_vote") {
    // 队伍投票：需要知道提名的队伍和之前的投票历史
    compressed.proposal = view.proposal;
    compressed.history = compressHistory(view.history?.teamVotes ?? [], 5);
  } else if (phase === "quest_vote") {
    // 任务投票：需要知道任务队伍和结果历史
    compressed.quest = view.quest;
    compressed.history = compressHistory(view.history?.quests ?? [], 5);
  } else if (phase === "assassination") {
    // 刺杀阶段：需要知道所有历史信息来推理梅林
    compressed.history = {
      proposals: compressHistory(view.history?.proposals ?? [], 5),
      teamVotes: compressHistory(view.history?.teamVotes ?? [], 5),
      quests: compressHistory(view.history?.quests ?? [], 5)
    };
    // 刺杀阶段需要更多座位信息来推理梅林
    compressed.seats = view.seats?.map(s => ({
      seatNo: s.seatNo,
      type: s.type
    })) ?? [];
  }

  // 只传递最近的聊天记录（最近10条）
  if (view.chat && view.chat.length > 0) {
    compressed.chat = view.chat.slice(-10).map(c => ({
      seatNo: c.seatNo,
      text: c.text?.substring(0, 100) ?? "", // 限制每条消息长度
      kind: c.kind
    }));
  }

  return compressed;
}

/**
 * 压缩历史记录，只保留最近N条的关键信息
 */
function compressHistory(history, limit) {
  if (!Array.isArray(history)) return [];
  return history.slice(-limit).map(item => {
    if (typeof item === "object") {
      // 只保留关键字段
      const compressed = {};
      if (item.leaderSeat !== undefined) compressed.leader = item.leaderSeat;
      if (item.team !== undefined) compressed.team = item.team;
      if (item.vote !== undefined) compressed.vote = item.vote;
      if (item.result !== undefined) compressed.result = item.result;
      if (item.success !== undefined) compressed.success = item.success;
      if (item.fail !== undefined) compressed.fail = item.fail;
      return compressed;
    }
    return item;
  });
}

/**
 * 压缩agentMemory，减少Token消耗
 * 只保留最近的关键信息，移除冗余字段
 */
function compressAgentMemory(agentMemory) {
  if (!agentMemory) return { short: [], long: [] };

  const compressSnapshot = (snapshot) => {
    // 只保留关键字段，移除冗余信息
    return {
      ts: snapshot.ts,
      phase: snapshot.phase,
      leader: snapshot.leaderSeat,
      team: snapshot.proposal?.team ?? null,
      vote: snapshot.teamVote ?? null,
      quest: snapshot.quest ?? null,
      score: snapshot.scoreboard
    };
  };

  // short记忆只保留最近10条
  const short = (agentMemory.short ?? []).slice(-10).map(compressSnapshot);
  // long记忆只保留最近5条
  const long = (agentMemory.long ?? []).slice(-5).map(compressSnapshot);

  return { short, long };
}

function computePlayerPrivateInfo(room, seatNo) {
  const p = room.playersBySeat.get(seatNo);
  if (!p) return null;
  const role = p.role;
  const alignment = roleAlignment(role);
  const evilSeats = [];
  for (const [s, pl] of room.playersBySeat.entries()) {
    if (roleAlignment(pl.role) === "evil") evilSeats.push(s);
  }

  const info = { seatNo, role, alignment, vision: {} };
  if (role === "merlin") {
    info.vision.evilSeats = evilSeats;
  }
  if (role === "percival") {
    const merlinCandidates = [];
    for (const [s, pl] of room.playersBySeat.entries()) {
      if (pl.role === "merlin" || pl.role === "morgana") merlinCandidates.push(s);
    }
    info.vision.merlinCandidates = merlinCandidates;
  }
  if (alignment === "evil") {
    info.vision.evilSeats = evilSeats;
  }
  return info;
}

function filterStateForViewer(room, viewer) {
  const base = room.game;
  const view = {
    viewer: { kind: viewer.kind, seatNo: viewer.seatNo ?? null },
    roomId: room.id,
    phase: base.phase,
    playerCount: base.playerCount,
    round: base.round,
    questNo: base.questNo,
    leaderSeat: base.leaderSeat,
    proposal: base.proposal ? { leaderSeat: base.proposal.leaderSeat, team: base.proposal.team } : null,
    teamVote: base.teamVote ? { results: base.teamVote.results, counts: base.teamVote.counts } : null,
    quest: base.quest ? { team: base.quest.team, requiredFails: base.quest.requiredFails, result: base.quest.result } : null,
    history: base.history,
    chat: base.chat.slice(-200),
    scoreboard: base.scoreboard,
    scenario: room.scenario,
    questPlan: room.questPlan,
    pending: null,
    seats: []
  };

  // 上帝视角：将 god-visibility 的投票事件注入聊天流，使上帝能看见每个玩家的实际投票
  if (viewer.kind === "god") {
    const godChatExtras = [];
    for (const e of room.events) {
      if (e.type === "quest_vote_cast" && e.visibility === "god") {
        const act = e.payload?.action === "fail" ? "失败" : "成功";
        godChatExtras.push({
          ts: e.ts,
          seatNo: e.actor?.seatNo ?? null,
          text: `任务投票：${act}`,
          kind: "public_chat"
        });
      }
    }
    if (godChatExtras.length > 0) {
      view.chat = view.chat.concat(godChatExtras).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    }
  }

  if (base.phase === "team_proposal") {
    view.pending = { type: "team_proposal", leaderSeat: base.leaderSeat, requiredTeamSize: requiredTeamSize(room) };
  } else if (base.phase === "team_prevote_chat") {
    const aiSeats = room.seats.filter((s) => room.playersBySeat.get(s)?.type === "ai");
    const spoken = base.preVoteChat?.spokenBySeat ?? {};
    const remainingSeats = aiSeats.filter((s) => !spoken[s]);
    view.pending = { type: "team_prevote_chat", remainingCount: remainingSeats.length };
    if (viewer.kind === "god") {
      view.pending.remainingSeats = remainingSeats;
    }
  } else if (base.phase === "team_vote") {
    const total = base.playerCount;
    const votedCount = Object.keys(base.teamVote?.votes ?? {}).length;
    const remainingCount = Math.max(0, total - votedCount);
    view.pending = { type: "team_vote", remainingCount };
    if (viewer.kind === "god") {
      const remainingSeats = room.seats.filter((s) => !base.teamVote?.votes?.[s]);
      view.pending.remainingSeats = remainingSeats;
    }
  } else if (base.phase === "quest_vote") {
    const team = base.quest?.team ?? [];
    const committedCount = Object.keys(base.quest?.votes ?? {}).length;
    const remainingCount = Math.max(0, team.length - committedCount);
    view.pending = { type: "quest_vote", team, remainingCount };
    if (viewer.kind === "god") {
      const remainingSeats = team.filter((s) => !base.quest?.votes?.[s]);
      view.pending.remainingSeats = remainingSeats;
    }
  } else if (base.phase === "assassination") {
    view.pending = { type: "assassination" };
    if (viewer.kind === "god") {
      const assassinSeat = room.seats.find((s) => room.playersBySeat.get(s)?.role === "assassin") ?? null;
      view.pending.assassinSeat = assassinSeat;
    }
  } else if (base.phase === "game_over") {
    view.pending = { type: "game_over", winner: base.winner ?? null };
  }

  for (const seatNo of room.seats) {
    const p = room.playersBySeat.get(seatNo);
    const seat = { seatNo, type: p.type };

    if (viewer.kind === "god") {
      seat.role = p.role;
      seat.alignment = roleAlignment(p.role);
      seat.model = p.llm?.model ?? null;
      seat.provider = p.llm?.provider ?? null;
      seat.agentName = p.agentName ?? null;
      seat.humanName = p.humanName ?? null;
    } else if (viewer.kind === "player" && viewer.seatNo === seatNo) {
      seat.role = p.role;
      seat.alignment = roleAlignment(p.role);
      seat.humanName = p.humanName ?? null;
    } else {
      seat.label = `Player ${seatNo}`;
    }

    view.seats.push(seat);
  }

  if (viewer.kind === "player" && viewer.seatNo) {
    view.privateInfo = computePlayerPrivateInfo(room, viewer.seatNo);
  }

  view.paused = Boolean(room.paused);

  // 为上帝视角提供AI思考过程数据（包含隐藏信息，仅上帝可见）
  view.thinkingHistory = [];
  if (viewer.kind === "god") {
    for (const e of room.events) {
      if (e.type === "ai_decision" && e.payload?.thinking) {
        view.thinkingHistory.push({
          seatNo: e.actor?.seatNo ?? null,
          ts: e.ts,
          phase: e.payload?.action?.type ?? null,
          thinking: e.payload.thinking,
          action: e.payload.action ?? null,
          modelMeta: e.modelMeta ?? null
        });
      }
      if (e.type === "ai_decision_fallback" && e.payload?.thinking) {
        view.thinkingHistory.push({
          seatNo: e.actor?.seatNo ?? null,
          ts: e.ts,
          phase: "fallback",
          thinking: e.payload.thinking,
          action: e.payload.fallback ?? null
        });
      }
    }
    // 只保留最近50条思考记录
    if (view.thinkingHistory.length > 50) {
      view.thinkingHistory = view.thinkingHistory.slice(-50);
    }
  }

  return view;
}

function createEmptyGame(playerCount) {
  return {
    phase: "lobby",
    playerCount,
    round: 1,
    questNo: 1,
    leaderSeat: 1,
    proposal: null,
    teamVote: null,
    quest: null,
    preVoteChat: null,
    history: {
      proposals: [],
      teamVotes: [],
      quests: [],
      assassination: null
    },
    chat: [],
    scoreboard: { success: 0, fail: 0, rejectsInRow: 0 },
    winner: null
  };
}

function createRoom({ seats, scenario, roleLlmMap, globalLlm }) {
  const id = rid("room");
  const playerCount = seats.length;
  const deck = shuffle(buildRoleDeck(playerCount));
  const seatNos = seats.map((s) => s.seatNo);
  const leaderSeat = seatNos[crypto.randomInt(0, seatNos.length)];

  const playersBySeat = new Map();
  for (const s of seats) {
    const role = deck.shift();
    const roleCfg = roleLlmMap && s.type === "ai" ? roleLlmMap[role] : null;
    playersBySeat.set(s.seatNo, {
      seatNo: s.seatNo,
      type: s.type,
      humanName: s.type === "human" ? (s.humanName ?? `Human ${s.seatNo}`) : null,
      agentName: s.type === "ai" ? (s.agentName ?? `Agent ${s.seatNo}`) : null,
      llm:
        s.type === "ai"
          ? {
              provider: normalizeProviderName(roleCfg?.provider ?? s.llm?.provider ?? "custom"),
              model: roleCfg?.model ?? (s.llm?.model ?? null),
              temperature: typeof roleCfg?.temperature === "number" ? roleCfg.temperature : typeof s.llm?.temperature === "number" ? s.llm.temperature : 0.6
            }
          : null,
      role
    });
  }

  const room = {
    id,
    createdAt: nowIso(),
    scenario: scenario ?? defaultScenario(),
    seats: seatNos,
    playersBySeat,
    roleLlmMap: roleLlmMap ?? null,
    globalLlm: globalLlm ?? null,
    paused: false,
    tokens: {
      god: rid("god"),
      spectator: rid("spec"),
      player: new Map()
    },
    socketsByToken: new Map(),
    events: [],
    game: createEmptyGame(playerCount),
    questPlan: pickQuestPlan(playerCount),
    agentMemoryBySeat: new Map()
  };

  for (const seatNo of seatNos) {
    const p = playersBySeat.get(seatNo);
    if (p.type === "human") {
      room.tokens.player.set(seatNo, rid(`p${seatNo}`));
    }
    if (p.type === "ai") {
      room.agentMemoryBySeat.set(seatNo, { short: [], long: [], trust: {}, suspicion: {} });
    }
  }

  room.game.leaderSeat = leaderSeat;
  room.game.phase = "team_proposal";

  // 初始化该房间的 LLM 请求日志路径
  const llmLogPath = path.join(LOG_DIR, `llm-requests-${room.id}.log`);
  roomLlmLogPaths.set(room.id, llmLogPath);

  appendEvent(room, {
    type: "game_created",
    actor: { kind: "system", seatNo: null },
    visibility: "god",
    payload: {
      roleLlmMap: roleLlmMap ?? null,
      seats: deepClone(seats).map((x) => ({
        seatNo: x.seatNo,
        type: x.type,
        humanName: x.humanName ?? null,
        agentName: x.agentName ?? null,
        llm: x.llm ?? null
      }))
    }
  });

  appendEvent(room, {
    type: "phase_changed",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { phase: room.game.phase, leaderSeat: room.game.leaderSeat }
  });

  return room;
}

function appendEvent(room, evt) {
  const e = {
    id: rid("evt"),
    ts: nowIso(),
    ...evt
  };
  room.events.push(e);
  if (e.type === "chat") {
    room.game.chat.push({
      ts: e.ts,
      seatNo: e.actor?.seatNo ?? null,
      text: e.payload?.text ?? "",
      kind: "public_chat"
    });
  } else if (e.visibility === "public") {
    const payload = e.payload ?? {};
    const pushSystem = (text) => {
      room.game.chat.push({
        ts: e.ts,
        seatNo: null,
        text,
        kind: "system"
      });
    };
    const pushPlayer = (seatNo, text) => {
      room.game.chat.push({
        ts: e.ts,
        seatNo: seatNo ?? null,
        text,
        kind: "public_chat"
      });
    };

    if (e.type === "phase_changed") {
      const phase = String(payload.phase ?? room.game.phase ?? "-").trim();
      const leaderSeat = payload.leaderSeat ?? room.game.leaderSeat ?? null;
      pushSystem(`阶段切换：${phaseLabelZh(phase)}${leaderSeat ? `（队长 #${leaderSeat}）` : ""}`);
    }
    if (e.type === "team_proposed") {
      const team = Array.isArray(payload.team) ? payload.team : [];
      pushPlayer(e.actor?.seatNo, `提名队伍：${team.join(", ")}`);
    }
    if (e.type === "team_vote_cast") {
      const vote = payload.vote === "approve" ? "赞成" : "反对";
      pushPlayer(e.actor?.seatNo, `投票：${vote}`);
    }
    if (e.type === "team_vote_result") {
      const passed = Boolean(payload.passed);
      const approve = Number(payload.approve ?? 0);
      const reject = Number(payload.reject ?? 0);
      pushSystem(`投票结果：${passed ? "通过" : "未通过"}（赞成 ${approve} / 反对 ${reject}）`);
    }
    if (e.type === "quest_started") {
      const team = Array.isArray(payload.team) ? payload.team : [];
      const requiredFails = Number(payload.requiredFails ?? 1);
      pushSystem(`任务开始：队伍 ${team.join(", ")}（至少 ${requiredFails} 票失败才算失败）`);
    }
    if (e.type === "quest_vote_cast_public") {
      const seatNo = payload.seatNo ?? null;
      pushSystem(`任务提交：#${seatNo} 已提交`);
    }
    if (e.type === "quest_result") {
      const questNo = Number(payload.questNo ?? room.game.questNo ?? 0);
      const result = payload.result === "fail" ? "失败" : "成功";
      const successCount = Number(payload.successCount ?? 0);
      const failCount = Number(payload.failCount ?? 0);
      pushSystem(`任务结果：第 ${questNo} 轮 ${result}（成功 ${successCount} / 失败 ${failCount}）`);
    }
    if (e.type === "assassination") {
      const targetSeat = payload.targetSeat ?? null;
      const hit = Boolean(payload.hit);
      pushPlayer(e.actor?.seatNo, `刺杀：目标 #${targetSeat}（${hit ? "命中梅林" : "未命中梅林"}）`);
    }
    if (e.type === "game_over") {
      const winner = payload.winner === "evil" ? "坏人" : payload.winner === "good" ? "好人" : String(payload.winner ?? "-");
      const reason = String(payload.reason ?? "");
      pushSystem(`游戏结束：${winner}胜利${reason ? `（${reason}）` : ""}`);
    }
    if (e.type === "game_paused") {
      pushSystem(payload.paused ? "游戏已暂停，AI行动已停止" : "游戏已恢复，AI行动将继续");
    }
  }

  if (room.game.chat.length > 200) {
    room.game.chat.splice(0, room.game.chat.length - 200);
  }
  broadcastViews(room);
  return e;
}

function viewerFromToken(room, token) {
  if (!token) return null;
  if (token === room.tokens.god) return { kind: "god", seatNo: null };
  if (token === room.tokens.spectator) return { kind: "spectator", seatNo: null };
  for (const [seatNo, t] of room.tokens.player.entries()) {
    if (t === token) return { kind: "player", seatNo };
  }
  return null;
}

function broadcastViews(room) {
  for (const [token, ws] of room.socketsByToken.entries()) {
    if (ws.readyState !== ws.OPEN) continue;
    const viewer = viewerFromToken(room, token);
    if (!viewer) continue;
    const view = filterStateForViewer(room, viewer);
    ws.send(JSON.stringify({ type: "state", view }));
  }
}

function nextLeader(room) {
  const idx = room.seats.indexOf(room.game.leaderSeat);
  const next = room.seats[(idx + 1) % room.seats.length];
  room.game.leaderSeat = next;
}

function requiredTeamSize(room) {
  return room.questPlan.sizes[room.game.questNo - 1];
}

function requiredFails(room) {
  return room.questPlan.fails[room.game.questNo - 1];
}

function currentProposal(room) {
  return room.game.proposal;
}

function beginTeamProposal(room) {
  room.game.phase = "team_proposal";
  room.game.proposal = null;
  room.game.teamVote = null;
  room.game.quest = null;
  room.game.preVoteChat = null;
  appendEvent(room, {
    type: "phase_changed",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { phase: room.game.phase, leaderSeat: room.game.leaderSeat }
  });
}

function beginTeamPreVoteChat(room) {
  room.game.phase = "team_prevote_chat";
  room.game.preVoteChat = { spokenBySeat: {} };
  room.game.teamVote = null;
  appendEvent(room, {
    type: "phase_changed",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { phase: room.game.phase }
  });
}

function maybeFinalizeTeamPreVoteChat(room) {
  if (room.game.phase !== "team_prevote_chat") return;
  const aiSeats = room.seats.filter((s) => room.playersBySeat.get(s)?.type === "ai");
  if (aiSeats.length === 0) {
    beginTeamVote(room);
    return;
  }
  const spoken = room.game.preVoteChat?.spokenBySeat ?? {};
  const remaining = aiSeats.filter((s) => !spoken[s]);
  if (remaining.length === 0) {
    beginTeamVote(room);
  }
}

function beginTeamVote(room) {
  if (!room.game.proposal?.team?.length) return;
  room.game.phase = "team_vote";
  room.game.preVoteChat = null;
  room.game.teamVote = { votes: {}, results: null, counts: null };
  appendEvent(room, {
    type: "phase_changed",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { phase: room.game.phase }
  });
}

function beginQuest(room, team) {
  room.game.phase = "quest_vote";
  room.game.quest = { team: stableSortBySeat(team), votes: {}, requiredFails: requiredFails(room), result: null };
  room.game.preVoteChat = null;
  appendEvent(room, {
    type: "quest_started",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { team: room.game.quest.team, requiredFails: room.game.quest.requiredFails }
  });
  appendEvent(room, {
    type: "phase_changed",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { phase: room.game.phase }
  });
}

function finalizeTeamVote(room) {
  const votes = room.game.teamVote.votes;
  const approve = Object.values(votes).filter((v) => v === "approve").length;
  const reject = Object.values(votes).filter((v) => v === "reject").length;
  const passed = approve > reject;
  room.game.teamVote.results = deepClone(votes);
  room.game.teamVote.counts = { approve, reject, passed };

  appendEvent(room, {
    type: "team_vote_result",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { approve, reject, passed }
  });

  if (passed) {
    room.game.scoreboard.rejectsInRow = 0;
    beginQuest(room, room.game.proposal.team);
    return;
  }

  room.game.scoreboard.rejectsInRow += 1;
  if (room.game.scoreboard.rejectsInRow >= 5) {
    room.game.winner = "evil";
    room.game.phase = "game_over";
    appendEvent(room, {
      type: "game_over",
      actor: { kind: "system", seatNo: null },
      visibility: "public",
      payload: { winner: "evil", reason: "Five team rejections in a row" }
    });
    saveGameHistory(room);
    return;
  }

  nextLeader(room);
  beginTeamProposal(room);
}

function finalizeQuest(room) {
  const votes = room.game.quest.votes;
  const failCount = Object.values(votes).filter((v) => v === "fail").length;
  const successCount = Object.values(votes).filter((v) => v === "success").length;
  const failed = failCount >= room.game.quest.requiredFails;
  const result = failed ? "fail" : "success";
  room.game.quest.result = result;

  room.game.history.quests.push({
    questNo: room.game.questNo,
    team: room.game.quest.team,
    requiredFails: room.game.quest.requiredFails,
    successCount,
    failCount,
    result
  });

  if (result === "success") room.game.scoreboard.success += 1;
  else room.game.scoreboard.fail += 1;

  appendEvent(room, {
    type: "quest_result",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { questNo: room.game.questNo, result, successCount, failCount, requiredFails: room.game.quest.requiredFails }
  });

  if (room.game.scoreboard.fail >= 3) {
    room.game.winner = "evil";
    room.game.phase = "game_over";
    appendEvent(room, {
      type: "game_over",
      actor: { kind: "system", seatNo: null },
      visibility: "public",
      payload: { winner: "evil", reason: "Three failed quests" }
    });
    saveGameHistory(room);
    return;
  }

  if (room.game.scoreboard.success >= 3) {
    room.game.phase = "assassination";
    appendEvent(room, {
      type: "phase_changed",
      actor: { kind: "system", seatNo: null },
      visibility: "public",
      payload: { phase: room.game.phase }
    });
    return;
  }

  room.game.questNo += 1;
  room.game.round += 1;
  nextLeader(room);
  beginTeamProposal(room);
}

function finalizeAssassination(room, assassinSeat, targetSeat) {
  room.game.history.assassination = { assassinSeat, targetSeat };
  const target = room.playersBySeat.get(targetSeat);
  const hit = target?.role === "merlin";
  const winner = hit ? "evil" : "good";
  room.game.winner = winner;
  room.game.phase = "game_over";
  appendEvent(room, {
    type: "assassination",
    actor: { kind: "player", seatNo: assassinSeat },
    visibility: "public",
    payload: { targetSeat, hit }
  });
  appendEvent(room, {
    type: "game_over",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { winner, reason: hit ? "Assassin hit Merlin" : "Assassin missed Merlin" }
  });
  saveGameHistory(room);
}

function isAssassin(room, seatNo) {
  const p = room.playersBySeat.get(seatNo);
  return p?.role === "assassin";
}

function isQuestMember(room, seatNo) {
  return room.game.quest?.team?.includes(seatNo);
}

function canQuestFail(room, seatNo) {
  const p = room.playersBySeat.get(seatNo);
  return roleAlignment(p?.role) === "evil";
}

function validateAndApplyAction(room, actorSeatNo, action) {
  if (room.game.phase === "game_over") return { ok: false, error: "game_over" };
  const actor = room.playersBySeat.get(actorSeatNo);
  if (!actor) return { ok: false, error: "invalid_actor" };

  if (action?.type === "say") {
    const text = String(action.text ?? "").slice(0, 2000);
    appendEvent(room, {
      type: "chat",
      actor: { kind: "player", seatNo: actorSeatNo },
      visibility: "public",
      payload: { text }
    });
    if (room.game.phase === "team_prevote_chat" && actor.type === "ai") {
      if (room.game.preVoteChat?.spokenBySeat) {
        room.game.preVoteChat.spokenBySeat[actorSeatNo] = true;
      }
      maybeFinalizeTeamPreVoteChat(room);
    }
    return { ok: true };
  }

  if (room.game.phase === "team_proposal") {
    if (actorSeatNo !== room.game.leaderSeat) return { ok: false, error: "not_leader" };
    if (action?.type !== "propose_team") return { ok: false, error: "expected_propose_team" };
    const team = Array.isArray(action.team) ? action.team.map((n) => clampInt(n, 1, room.game.playerCount, 1)) : [];
    const uniq = [...new Set(team)];
    if (uniq.length !== requiredTeamSize(room)) return { ok: false, error: "bad_team_size" };
    for (const s of uniq) {
      if (!room.playersBySeat.has(s)) return { ok: false, error: "bad_team_member" };
    }
    const sortedTeam = stableSortBySeat(uniq);
    room.game.proposal = { leaderSeat: room.game.leaderSeat, team: sortedTeam };
    appendEvent(room, {
      type: "team_proposed",
      actor: { kind: "player", seatNo: room.game.leaderSeat },
      visibility: "public",
      payload: { team: room.game.proposal.team, requiredTeamSize: requiredTeamSize(room) }
    });

    if (actor.type === "ai") {
      const rawReason = String(action.reason ?? "").trim();
      const reason = rawReason ? rawReason.slice(0, 220) : "目前信息不足，我更倾向用这队先拿到投票与任务表现信息。";
      appendEvent(room, {
        type: "chat",
        actor: { kind: "player", seatNo: actorSeatNo },
        visibility: "public",
        payload: { text: `本轮我选择玩家 ${sortedTeam.join(" 和 ")} 出征，${reason}` }
      });
    }

    beginTeamPreVoteChat(room);
    maybeFinalizeTeamPreVoteChat(room);
    return { ok: true };
  }

  if (room.game.phase === "team_prevote_chat") {
    return { ok: false, error: "expected_say" };
  }

  if (room.game.phase === "team_vote") {
    if (action?.type !== "vote_team") return { ok: false, error: "expected_vote_team" };
    const vote = action.vote === "approve" ? "approve" : "reject";
    room.game.teamVote.votes[actorSeatNo] = vote;
    const rawReason = String(action.reason ?? "").trim();
    const reason = rawReason
      ? rawReason.slice(0, 220)
      : vote === "approve"
        ? "这队目前看起来相对合理，先通过拿信息。"
        : "这队风险偏高，我倾向换队再观察。";
    appendEvent(room, {
      type: "team_vote_cast",
      actor: { kind: "player", seatNo: actorSeatNo },
      visibility: "public",
      payload: { vote, reason }
    });
    if (Object.keys(room.game.teamVote.votes).length === room.game.playerCount) {
      finalizeTeamVote(room);
    }
    return { ok: true };
  }

  if (room.game.phase === "quest_vote") {
    if (!isQuestMember(room, actorSeatNo)) return { ok: false, error: "not_on_quest" };
    if (action?.type !== "quest_action") return { ok: false, error: "expected_quest_action" };
    let act = action.action === "fail" ? "fail" : "success";
    if (act === "fail" && !canQuestFail(room, actorSeatNo)) act = "success";
    room.game.quest.votes[actorSeatNo] = act;
    appendEvent(room, {
      type: "quest_vote_cast",
      actor: { kind: "player", seatNo: actorSeatNo },
      visibility: "god",
      payload: { action: act }
    });
    appendEvent(room, {
      type: "quest_vote_cast_public",
      actor: { kind: "system", seatNo: null },
      visibility: "public",
      payload: { seatNo: actorSeatNo, committed: true }
    });
    if (Object.keys(room.game.quest.votes).length === room.game.quest.team.length) {
      finalizeQuest(room);
    }
    return { ok: true };
  }

  if (room.game.phase === "assassination") {
    if (!isAssassin(room, actorSeatNo)) return { ok: false, error: "not_assassin" };
    if (action?.type !== "assassinate") return { ok: false, error: "expected_assassinate" };
    const target = clampInt(action.target, 1, room.game.playerCount, 1);
    if (!room.playersBySeat.has(target)) return { ok: false, error: "bad_target" };
    finalizeAssassination(room, actorSeatNo, target);
    return { ok: true };
  }

  return { ok: false, error: "invalid_phase_or_action" };
}

function computeAgentView(room, seatNo) {
  return filterStateForViewer(room, { kind: "player", seatNo });
}

function agentUpdateMemory(room, seatNo) {
  const mem = room.agentMemoryBySeat.get(seatNo);
  if (!mem) return;
  const view = computeAgentView(room, seatNo);
  
  // 压缩记忆快照：只存储关键信息
  const snapshot = {
    ts: nowIso(),
    phase: view.phase,
    leader: view.leaderSeat,
    team: view.proposal?.team ?? null,
    score: view.scoreboard
  };
  
  // 只在关键阶段存储详细信息
  if (view.phase === "team_vote") {
    snapshot.votes = view.teamVote?.counts ?? null;
  } else if (view.phase === "quest_vote") {
    snapshot.quest = view.quest?.result ?? null;
  }
  
  // short记忆：减少到15条
  mem.short.push(snapshot);
  if (mem.short.length > 15) mem.short.shift();
  
  // long记忆：减少到20条，只在关键时刻存储
  if (mem.long.length < 20 && (view.phase === "quest_vote" || view.phase === "assassination" || view.phase === "game_over")) {
    mem.long.push(snapshot);
  }
}

async function runAiTurnIfNeeded(room) {
  if (room.game.phase === "game_over") return;
  if (room.paused) return;

  if (room.game.phase === "team_proposal") {
    const leader = room.playersBySeat.get(room.game.leaderSeat);
    if (leader?.type !== "ai") return;
    await runAiAction(room, leader.seatNo);
    return;
  }

  if (room.game.phase === "team_prevote_chat") {
    const spoken = room.game.preVoteChat?.spokenBySeat ?? {};
    for (const seatNo of room.seats) {
      const p = room.playersBySeat.get(seatNo);
      if (p.type !== "ai") continue;
      if (spoken[seatNo]) continue;
      await runAiAction(room, seatNo);
    }
    maybeFinalizeTeamPreVoteChat(room);
    return;
  }

  if (room.game.phase === "team_vote") {
    for (const seatNo of room.seats) {
      const p = room.playersBySeat.get(seatNo);
      if (p.type !== "ai") continue;
      if (room.game.teamVote.votes[seatNo]) continue;
      await runAiAction(room, seatNo);
    }
    return;
  }

  if (room.game.phase === "quest_vote") {
    for (const seatNo of room.game.quest.team) {
      const p = room.playersBySeat.get(seatNo);
      if (p.type !== "ai") continue;
      if (room.game.quest.votes[seatNo]) continue;
      await runAiAction(room, seatNo);
    }
    return;
  }

  if (room.game.phase === "assassination") {
    for (const seatNo of room.seats) {
      const p = room.playersBySeat.get(seatNo);
      if (p.role !== "assassin") continue;
      if (p.type !== "ai") return;
      await runAiAction(room, seatNo);
      return;
    }
  }
}

async function runAiAction(room, seatNo) {
  const p = room.playersBySeat.get(seatNo);
  if (!p || p.type !== "ai") return;

  agentUpdateMemory(room, seatNo);
  const view = computeAgentView(room, seatNo);
  const privateInfo = computePlayerPrivateInfo(room, seatNo);
  const agentMemory = room.agentMemoryBySeat.get(seatNo) ?? { short: [], long: [] };

  const required = requiredTeamSize(room);
  const ctx = { phase: room.game.phase, requiredTeamSize: required, seatNo, playerCount: room.game.playerCount };

  const useLlm = Boolean(p.llm?.provider);
  let action = null;
  let thinking = null;
  let modelMeta = null;

  if (useLlm) {
    const prompt = buildAgentPrompt({ view, privateInfo, agentMemory, scenario: room.scenario });
    const started = Date.now();
    const r = await llmChatWithFallback({
      provider: p.llm.provider,
      model: p.llm.model,
      messages: prompt.messages,
      temperature: p.llm.temperature,
      fallbackProvider: room.globalLlm?.provider ?? "custom",
      fallbackModel: room.globalLlm?.model ?? null,
      roomId: room.id
    });
    const elapsedMs = Date.now() - started;

    const parsed = safeJsonParse(r.text.trim());
    if (r.ok && parsed.ok) {
      // 兼容新格式（含thinking）和旧格式（纯action）
      if (parsed.value && typeof parsed.value === "object" && parsed.value.action) {
        thinking = String(parsed.value.thinking ?? "").trim() || null;
        action = parsed.value.action;
      } else {
        action = parsed.value;
      }
    } else {
      action = pickFallbackAction(ctx);
    }

    // 构建 modelMeta，包含 fallback 信息
    const actualProvider = r.fallbackUsed ? (r.fallbackProvider ?? room.globalLlm?.provider ?? "custom") : p.llm.provider;
    const actualModel = r.fallbackUsed
      ? (providerEnv(r.fallbackProvider ?? room.globalLlm?.provider ?? "custom").model ?? null)
      : (p.llm.model ?? providerEnv(p.llm.provider).model ?? null);

    modelMeta = {
      provider: actualProvider,
      model: actualModel,
      ok: r.ok,
      elapsedMs,
      usage: r.usage,
      error: r.ok ? null : r.raw?.error ?? "llm_error",
      fallbackUsed: r.fallbackUsed || false,
      fallbackProvider: r.fallbackUsed ? (r.fallbackProvider ?? room.globalLlm?.provider ?? "custom") : undefined,
      originalProvider: r.fallbackUsed ? r.originalProvider : undefined,
      originalError: r.fallbackUsed ? r.originalError : undefined
    };
  } else {
    action = pickFallbackAction(ctx);
    // 非LLM玩家使用fallback时生成一段模拟思考过程
    thinking = generateFallbackThinking(room, seatNo, action);
  }

  appendEvent(room, {
    type: "ai_decision",
    actor: { kind: "player", seatNo },
    visibility: "god",
    payload: { action, thinking },
    modelMeta
  });

  // 存储思考过程到agentMemory，便于前端获取
  if (thinking) {
    const mem = room.agentMemoryBySeat.get(seatNo);
    if (mem) {
      if (!mem.thinkingHistory) mem.thinkingHistory = [];
      mem.thinkingHistory.push({
        ts: nowIso(),
        phase: room.game.phase,
        thinking,
        action
      });
      // 最多保留最近20条思考记录
      if (mem.thinkingHistory.length > 20) mem.thinkingHistory.shift();
    }
  }

  const applied = validateAndApplyAction(room, seatNo, action);
  if (!applied.ok) {
    const fallback = pickFallbackAction(ctx);
    const fallbackThinking = thinking ? `${thinking}\n\n[原始决策失败: ${applied.error}，使用备用方案]` : `原始决策失败(${applied.error})，使用备用方案`;
    appendEvent(room, {
      type: "ai_decision_fallback",
      actor: { kind: "player", seatNo },
      visibility: "god",
      payload: { error: applied.error, fallback, thinking: fallbackThinking }
    });
    validateAndApplyAction(room, seatNo, fallback);
  }

  await runAiTurnIfNeeded(room);
}

function generateFallbackThinking(room, seatNo, action) {
  const p = room.playersBySeat.get(seatNo);
  const role = p?.role ?? "unknown";
  const phase = room.game.phase;

  if (phase === "team_proposal") {
    const team = Array.isArray(action.team) ? action.team.join(", ") : "?";
    return `我是${role}，当前轮次我作为队长需要提名队伍。我选择[${team}]出征，这是基于当前信息下的合理配置。`;
  }
  if (phase === "team_prevote_chat") {
    return `我是${role}，需要对本轮提名的队伍发表公开看法。我会表达适度支持或保留态度，避免泄露身份信息。`;
  }
  if (phase === "team_vote") {
    const vote = action.vote === "approve" ? "赞成" : "反对";
    return `我是${role}，本轮投票我选择${vote}。这是基于当前对局势的判断，同时需要保持我的投票模式一致性以避免被识破。`;
  }
  if (phase === "quest_vote") {
    return `我是${role}，作为任务成员我需要决定任务成败。我会根据阵营利益做出选择。`;
  }
  if (phase === "assassination") {
    const target = action.target ?? "?";
    return `我是${role}，现在是刺杀阶段。我需要分析所有人的投票模式和发言内容来判断谁是梅林。我选择刺杀#${target}。`;
  }
  return `我是${role}，基于当前局势做出决策。`;
}

function computePostGameAnalysis(room) {
  const bySeat = {};
  for (const seatNo of room.seats) {
    bySeat[seatNo] = { seatNo, role: room.playersBySeat.get(seatNo)?.role ?? null, votes: { team: [], quest: [] } };
  }

  for (const e of room.events) {
    if (e.type === "team_vote_cast") {
      bySeat[e.actor.seatNo]?.votes?.team?.push({ ts: e.ts, vote: e.payload.vote });
    }
    if (e.type === "quest_vote_cast") {
      bySeat[e.actor.seatNo]?.votes?.quest?.push({ ts: e.ts, action: e.payload.action });
    }
  }

  return {
    roomId: room.id,
    winner: room.game.winner,
    scoreboard: room.game.scoreboard,
    roles: room.seats.map((s) => ({
      seatNo: s,
      role: room.playersBySeat.get(s)?.role ?? null,
      alignment: roleAlignment(room.playersBySeat.get(s)?.role)
    })),
    perSeat: bySeat
  };
}

/** 将已结束的对局保存到本地历史文件 */
function saveGameHistory(room) {
  try {
    ensureLocalDir();
    fs.mkdirSync(HISTORY_DIR, { recursive: true });

    const players = {};
    for (const seatNo of room.seats) {
      const p = room.playersBySeat.get(seatNo);
      players[seatNo] = {
        seatNo,
        type: p.type,
        role: p.role,
        alignment: roleAlignment(p.role),
        agentName: p.agentName ?? null,
        humanName: p.humanName ?? null,
        llm: p.llm ? { provider: p.llm.provider, model: p.llm.model } : null
      };
    }

    // 从事件中提取AI思考记录
    const thinkingHistory = [];
    for (const e of room.events) {
      if ((e.type === "ai_decision" || e.type === "ai_decision_fallback") && e.payload?.thinking) {
        thinkingHistory.push({
          seatNo: e.actor?.seatNo ?? null,
          ts: e.ts,
          phase: e.payload?.action?.type ?? "fallback",
          thinking: e.payload.thinking,
          action: e.payload.action ?? e.payload?.fallback ?? null,
          modelMeta: e.modelMeta ?? null
        });
      }
    }

    const record = {
      roomId: room.id,
      createdAt: room.createdAt,
      savedAt: nowIso(),
      scenario: room.scenario,
      playerCount: room.game.playerCount,
      seats: room.seats,
      players,
      winner: room.game.winner,
      scoreboard: room.game.scoreboard,
      history: room.game.history,
      questPlan: room.questPlan,
      chat: room.game.chat,
      thinkingHistory,
      events: room.events
    };

    const filename = `${room.id}.json`;
    const filepath = path.join(HISTORY_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(record, null, 2), "utf8");
    console.log(`[history] saved roomId=${room.id} -> ${filename}`);
  } catch (err) {
    console.error(`[history] save_failed roomId=${room.id}`, err);
  } finally {
    // 清理该房间的 LLM 请求日志路径映射
    roomLlmLogPaths.delete(room.id);
  }
}

const rooms = new Map();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function isLocalRequest(req) {
  const ra = req.socket?.remoteAddress ?? "";
  return ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
}

function readLogTail(filePath, maxLines = 80) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trim();
  } catch (err) {
    return `[log_read_error] ${String(err?.message ?? err)}`;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

app.get("/api/runtime-logs", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const lines = clampInt(req.query?.lines, 20, 300, 80);
  res.json({
    ok: true,
    logs: {
      stdout: readLogTail(SERVER_STDOUT_LOG_PATH, lines),
      stderr: readLogTail(SERVER_STDERR_LOG_PATH, lines)
    }
  });
});

app.get("/api/llm/providers", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const builtin = ["custom", "deepseek", "xiaomi", "aliyun", "doubao", "kimi"];
  // 从本地配置中读取已添加的自定义 provider
  const customProviders = Object.keys(llmConfigStore).filter((p) => !builtin.includes(p));
  const allProviders = [...builtin, ...customProviders];
  const failureStatus = getProviderFailureStatus();
  const status = allProviders.map((p) => {
    const env = providerEnv(p);
    const failure = failureStatus[p] ?? { failureCount: 0, disabled: false };
    return {
      provider: p,
      hasBaseUrl: Boolean(env.baseUrl),
      hasApiKey: Boolean(env.apiKey),
      hasModel: Boolean(env.model),
      source: llmConfigStore[p] ? "ui" : "env",
      failureCount: failure.failureCount,
      disabled: failure.disabled,
      isCustom: !builtin.includes(p)
    };
  });
  res.json({ ok: true, providers: status, customProviders });
});

app.get("/api/llm/config", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const provider = normalizeProviderName(req.query?.provider);
  const stored = llmConfigStore[provider] ?? {};
  const envPrefix = provider.toUpperCase();
  const merged = providerEnv(provider);
  res.json({
    ok: true,
    provider,
    config: {
      baseUrl: merged.baseUrl ?? "",
      model: merged.model ?? "",
      apiKey: "",
      apiKeyMasked: Boolean(merged.apiKey) ? "************" : "",
      hasApiKey: Boolean(merged.apiKey),
      timeoutMs: stored.timeoutMs ?? null,
      defaultTimeoutMs: 60000,
      source: llmConfigStore[provider] ? "ui" : "env",
      envKeys: [`${envPrefix}_BASE_URL`, `${envPrefix}_API_KEY`, `${envPrefix}_MODEL`]
    },
    stored: {
      hasStored: Boolean(llmConfigStore[provider]),
      hasApiKey: Boolean(stored.apiKey),
      models: Array.isArray(stored.models) ? stored.models : []
    }
  });
});

app.post("/api/llm/config", (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const provider = normalizeProviderName(req.body?.provider);
  const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : "";
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
  const clearApiKey = Boolean(req.body?.clearApiKey);
  const timeoutMs = typeof req.body?.timeoutMs === "number" && Number.isFinite(req.body.timeoutMs) ? clampInt(req.body.timeoutMs, 1000, 300000, null) : null;
  const clearTimeout = req.body?.timeoutMs === null || req.body?.clearTimeout === true;

  if (clearApiKey) {
    const prev = llmConfigStore[provider] ?? null;
    if (!prev) {
      return res.json({ ok: true, provider, clearedApiKey: true, hasApiKey: false });
    }
    llmConfigStore[provider] = { ...prev, apiKey: null };
    saveLlmConfig(llmConfigStore);
    return res.json({ ok: true, provider, clearedApiKey: true, hasApiKey: false });
  }

  if (!baseUrl && !apiKey && !model && clearTimeout) {
    delete llmConfigStore[provider];
    saveLlmConfig(llmConfigStore);
    return res.json({ ok: true, provider, cleared: true });
  }

  const prevConfig = llmConfigStore[provider] ?? {};
  llmConfigStore[provider] = {
    baseUrl: baseUrl || prevConfig.baseUrl || null,
    apiKey: apiKey || (prevConfig.apiKey ?? null),
    model: model || prevConfig.model || null,
    timeoutMs: clearTimeout ? null : (timeoutMs ?? prevConfig.timeoutMs ?? null)
  };
  saveLlmConfig(llmConfigStore);
  
  // 保存配置后重置该 provider 的失败计数
  resetProviderFailure(provider);
  
  res.json({ ok: true, provider, saved: true, hasApiKey: Boolean(llmConfigStore[provider]?.apiKey), timeoutMs: llmConfigStore[provider]?.timeoutMs ?? null });
});

app.post("/api/llm/test", async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });
  const provider = normalizeProviderName(req.body?.provider);
  const baseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : null;
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : null;
  const model = typeof req.body?.model === "string" ? req.body.model.trim() : null;

  const prev = llmConfigStore[provider] ?? null;
  const tempCfg = {
    baseUrl: baseUrl || prev?.baseUrl || null,
    apiKey: apiKey || prev?.apiKey || null,
    model: model || prev?.model || null
  };

  if (tempCfg.baseUrl || tempCfg.apiKey || tempCfg.model) {
    llmConfigStore[provider] = tempCfg;
  }

  const started = Date.now();
  const r = await llmChat({
    provider,
    model: tempCfg.model,
    temperature: 0,
    messages: [
      { role: "system", content: "You are a connection test. Reply with exactly: OK" },
      { role: "user", content: "ping" }
    ],
    roomId: null
  }).catch((err) => ({ ok: false, text: "", usage: null, raw: { error: String(err?.message ?? err) } }));
  const elapsedMs = Date.now() - started;

  if (prev) llmConfigStore[provider] = prev;
  else delete llmConfigStore[provider];

  // 测试成功时重置该 provider 的失败计数
  if (r.ok) {
    resetProviderFailure(provider);
  }

  res.json({
    ok: true,
    provider,
    test: {
      success: Boolean(r.ok && String(r.text ?? "").trim().length > 0),
      httpOk: Boolean(r.ok),
      elapsedMs,
      sample: String(r.text ?? "").trim().slice(0, 200),
      error: r.ok ? null : (r.raw?.error ?? "llm_error"),
      usage: r.usage ?? null
    }
  });
});

app.post("/api/llm/test-batch", async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });

  const provider = normalizeProviderName(req.body?.provider);
  const baseBaseUrl = typeof req.body?.baseUrl === "string" ? req.body.baseUrl.trim() : null;
  const baseApiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : null;
  const requestModels = Array.isArray(req.body?.models)
    ? req.body.models.filter((m) => typeof m === "string" && m.trim().length > 0).map((m) => m.trim())
    : [];

  const stored = llmConfigStore[provider] ?? null;
  const resolvedBaseUrl = baseBaseUrl || stored?.baseUrl || null;
  const resolvedApiKey = baseApiKey || stored?.apiKey || null;

  if (!resolvedBaseUrl || !resolvedApiKey) {
    return res.status(400).json({ ok: false, error: `provider=${provider} 缺少 baseUrl 或 apiKey，无法批量测试` });
  }

  const candidateModels = requestModels.length > 0
    ? requestModels
    : (stored?.models ?? (stored?.model ? [stored.model] : []));

  if (candidateModels.length === 0) {
    return res.status(400).json({ ok: false, error: `provider=${provider} 未配置可测试模型列表` });
  }

  const results = [];
  const concurrency = 2;

  async function testSingleModel(modelName) {
    const tempStoreKey = `__batch_test_${provider}_${modelName}`;
    const prevStore = llmConfigStore[provider] ?? null;
    llmConfigStore[provider] = {
      baseUrl: resolvedBaseUrl,
      apiKey: resolvedApiKey,
      model: modelName,
      models: prevStore?.models ?? []
    };

    const started = Date.now();
    const r = await llmChat({
      provider,
      model: modelName,
      temperature: 0,
      messages: [
        { role: "system", content: "You are a connection test. Reply with exactly: OK" },
        { role: "user", content: "ping" }
      ],
      roomId: null
    }).catch((err) => ({ ok: false, text: "", usage: null, raw: { error: String(err?.message ?? err) } }));
    const elapsedMs = Date.now() - started;

    if (prevStore) llmConfigStore[provider] = prevStore;
    else delete llmConfigStore[provider];

    if (r.ok) resetProviderFailure(provider);

    results.push({
      model: modelName,
      success: Boolean(r.ok && String(r.text ?? "").trim().length > 0),
      httpOk: Boolean(r.ok),
      elapsedMs,
      sample: String(r.text ?? "").trim().slice(0, 200),
      error: r.ok ? null : (r.raw?.error ?? "llm_error"),
      usage: r.usage ?? null
    });
  }

  for (let i = 0; i < candidateModels.length; i += concurrency) {
    const batch = candidateModels.slice(i, i + concurrency);
    await Promise.all(batch.map((m) => testSingleModel(m)));
  }

  res.json({
    ok: true,
    provider,
    modelsCount: candidateModels.length,
    results
  });
});

app.post("/api/rooms", async (req, res) => {
  const playerCount = clampInt(req.body?.playerCount, 5, 10, 7);
  const humanCount = clampInt(req.body?.humanCount, 0, playerCount, 1);
  const scenario = typeof req.body?.scenario === "string" ? req.body.scenario.slice(0, 1000) : undefined;
  const roleLlmMapNorm = normalizeRoleLlmMap(req.body?.roleLlmMap);
  if (roleLlmMapNorm?.error) {
    return res.status(400).json({ ok: false, error: roleLlmMapNorm.error, detail: roleLlmMapNorm.detail });
  }
  const roleLlmMap = roleLlmMapNorm && !roleLlmMapNorm.error ? roleLlmMapNorm : null;

  const seats = [];
  for (let i = 1; i <= playerCount; i++) {
    if (i <= humanCount) {
      seats.push({ seatNo: i, type: "human", humanName: `Human ${i}` });
    } else {
      seats.push({
        seatNo: i,
        type: "ai",
        agentName: `Agent ${i}`,
        llm: {
          provider: req.body?.aiProvider ?? "custom",
          model: req.body?.aiModel ?? null,
          temperature: typeof req.body?.aiTemperature === "number" ? req.body.aiTemperature : 0.6
        }
      });
    }
  }

  const room = createRoom({
    seats,
    scenario,
    roleLlmMap,
    globalLlm: {
      provider: req.body?.aiProvider ?? "custom",
      model: req.body?.aiModel ?? null
    }
  });
  rooms.set(room.id, room);

  console.log(`[rooms] created roomId=${room.id} playerCount=${playerCount} humanCount=${humanCount} leaderSeat=${room.game.leaderSeat}`);
  queueMicrotask(() => {
    runAiTurnIfNeeded(room).catch((err) => {
      console.error(`[rooms] kickoff_ai_failed roomId=${room.id}`, err);
    });
  });

  res.json({
    ok: true,
    roomId: room.id,
    tokens: {
      god: room.tokens.god,
      spectator: room.tokens.spectator,
      players: Object.fromEntries(room.tokens.player.entries())
    }
  });
});

// 获取进行中的房间列表（非 game_over 状态）
app.get("/api/rooms/active", (_req, res) => {
  const activeRooms = [];
  for (const [roomId, room] of rooms.entries()) {
    if (room.game.phase === "game_over") continue;
    activeRooms.push({
      roomId,
      createdAt: room.createdAt,
      playerCount: room.seats.length,
      phase: room.game.phase,
      questNo: room.game.questNo,
      leaderSeat: room.game.leaderSeat,
      score: {
        success: room.game.scoreboard?.success ?? 0,
        fail: room.game.scoreboard?.fail ?? 0
      },
      godToken: room.tokens.god
    });
  }
  // 按创建时间倒序排列，最新的在前
  activeRooms.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  res.json({ ok: true, rooms: activeRooms });
});

app.get("/api/rooms/:roomId/state", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "not_found" });
  const token = String(req.query?.token ?? "");
  const viewer = viewerFromToken(room, token);
  if (!viewer) return res.status(401).json({ ok: false, error: "unauthorized" });
  const view = filterStateForViewer(room, viewer);
  res.json({ ok: true, view });
});

app.get("/api/rooms/:roomId/events", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "not_found" });
  const token = String(req.query?.token ?? "");
  const viewer = viewerFromToken(room, token);
  if (!viewer) return res.status(401).json({ ok: false, error: "unauthorized" });

  let events = room.events;
  if (viewer.kind !== "god") {
    events = events.filter((e) => e.visibility === "public");
  }
  res.json({ ok: true, events });
});

app.get("/api/rooms/:roomId/analysis", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "not_found" });
  const token = String(req.query?.token ?? "");
  const viewer = viewerFromToken(room, token);
  if (!viewer || viewer.kind !== "god") return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({ ok: true, analysis: computePostGameAnalysis(room) });
});

app.post("/api/rooms/:roomId/action", async (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "not_found" });
  const token = String(req.body?.token ?? "");
  const viewer = viewerFromToken(room, token);
  if (!viewer || viewer.kind !== "player") return res.status(401).json({ ok: false, error: "unauthorized" });

  const action = req.body?.action ?? null;
  const applied = validateAndApplyAction(room, viewer.seatNo, action);
  if (!applied.ok) return res.status(400).json({ ok: false, error: applied.error });

  await runAiTurnIfNeeded(room);
  res.json({ ok: true });
});

// 暂停/恢复游戏（仅上帝可用）
app.post("/api/rooms/:roomId/pause", async (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "not_found" });
  const token = String(req.body?.token ?? "");
  const viewer = viewerFromToken(room, token);
  if (!viewer || viewer.kind !== "god") return res.status(401).json({ ok: false, error: "unauthorized" });

  room.paused = !room.paused;
  appendEvent(room, {
    type: "game_paused",
    actor: { kind: "system", seatNo: null },
    visibility: "public",
    payload: { paused: room.paused }
  });

  // 恢复时触发AI回合
  if (!room.paused) {
    queueMicrotask(() => {
      runAiTurnIfNeeded(room).catch((err) => {
        console.error(`[rooms] resume_ai_failed roomId=${room.id}`, err);
      });
    });
  }

  res.json({ ok: true, paused: room.paused });
});

// 强制结束游戏（仅上帝可用）
app.post("/api/rooms/:roomId/end", async (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ ok: false, error: "not_found" });
  const token = String(req.body?.token ?? "");
  const viewer = viewerFromToken(room, token);
  if (!viewer || viewer.kind !== "god") return res.status(401).json({ ok: false, error: "unauthorized" });

  if (room.game.phase !== "game_over") {
    room.game.winner = null;
    room.game.phase = "game_over";
    appendEvent(room, {
      type: "game_over",
      actor: { kind: "system", seatNo: null },
      visibility: "public",
      payload: { winner: null, reason: "上帝强制结束游戏" }
    });
    saveGameHistory(room);
  }

  res.json({ ok: true });
});

// === 对局历史回放 API ===

/** 获取所有历史对局列表 */
app.get("/api/rooms/history", (_req, res) => {
  try {
    ensureLocalDir();
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const files = fs.readdirSync(HISTORY_DIR).filter((f) => f.endsWith(".json")).sort().reverse();
    const list = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(HISTORY_DIR, file), "utf8");
        const data = JSON.parse(raw);
        list.push({
          roomId: data.roomId,
          createdAt: data.createdAt,
          savedAt: data.savedAt,
          playerCount: data.playerCount,
          winner: data.winner,
          scoreboard: data.scoreboard,
          scenario: (data.scenario ?? "").slice(0, 100),
          players: Object.values(data.players ?? {}).map((p) => ({
            seatNo: p.seatNo,
            role: p.role,
            alignment: p.alignment,
            type: p.type,
            agentName: p.agentName,
            llm: p.llm ? { provider: p.llm.provider, model: p.llm.model } : null
          }))
        });
      } catch (err) {
        console.warn(`[history] skip_invalid file=${file}`, err.message);
      }
    }
    res.json({ ok: true, history: list });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message ?? err) });
  }
});

/** 获取单个历史对局的完整回放数据 */
app.get("/api/rooms/history/:roomId", (req, res) => {
  try {
    const filepath = path.join(HISTORY_DIR, `${req.params.roomId}.json`);
    if (!fs.existsSync(filepath)) return res.status(404).json({ ok: false, error: "not_found" });
    const raw = fs.readFileSync(filepath, "utf8");
    const data = JSON.parse(raw);
    res.json({ ok: true, game: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message ?? err) });
  }
});

/** 删除单个历史对局 */
app.delete("/api/rooms/history/:roomId", (req, res) => {
  try {
    const filepath = path.join(HISTORY_DIR, `${req.params.roomId}.json`);
    if (!fs.existsSync(filepath)) return res.status(404).json({ ok: false, error: "not_found" });
    fs.unlinkSync(filepath);
    console.log(`[history] deleted roomId=${req.params.roomId}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message ?? err) });
  }
});

/** AI复盘：用LLM对历史对局进行深度分析 */
app.post("/api/rooms/history/:roomId/ai-review", async (req, res) => {
  try {
    const filepath = path.join(HISTORY_DIR, `${req.params.roomId}.json`);
    if (!fs.existsSync(filepath)) return res.status(404).json({ ok: false, error: "not_found" });
    const raw = fs.readFileSync(filepath, "utf8");
    const game = JSON.parse(raw);

    // 构建复盘上下文
    const winnerText = game.winner === "good" ? "好人阵营胜利" : game.winner === "evil" ? "坏人阵营胜利" : "未分胜负（强制结束）";
    const scoreText = `任务成功 ${game.scoreboard?.success ?? 0} / 失败 ${game.scoreboard?.fail ?? 0}`;

    // 玩家角色信息
    const playerLines = Object.values(game.players ?? {}).map((p) => {
      const llm = p.llm ? `${p.llm.provider}:${p.llm.model}` : "人类/无LLM";
      return `#${p.seatNo} ${p.role}(${p.alignment}) ${llm}`;
    });

    // 提取关键事件摘要
    const eventSummary = [];
    for (const e of game.events ?? []) {
      if (e.type === "team_proposed") {
        eventSummary.push(`[${e.ts}] #${e.actor?.seatNo} 提名队伍 [${(e.payload?.team ?? []).join(",")}]`);
      } else if (e.type === "team_vote_result") {
        eventSummary.push(`[${e.ts}] 投票${e.payload?.passed ? "通过" : "未通过"}（赞成${e.payload?.approve}/反对${e.payload?.reject}）`);
      } else if (e.type === "quest_result") {
        eventSummary.push(`[${e.ts}] 第${e.payload?.questNo}轮任务${e.payload?.result === "success" ? "成功" : "失败"}（成功${e.payload?.successCount}/失败${e.payload?.failCount}）`);
      } else if (e.type === "assassination") {
        eventSummary.push(`[${e.ts}] 刺客刺杀 #${e.payload?.targetSeat}（${e.payload?.hit ? "命中梅林" : "未命中"}）`);
      } else if (e.type === "game_over") {
        eventSummary.push(`[${e.ts}] 游戏结束: ${e.payload?.winner === "good" ? "好人胜" : e.payload?.winner === "evil" ? "坏人胜" : "强制结束"}（${e.payload?.reason ?? ""}）`);
      }
    }

    // 提取AI思考过程摘要（每位玩家最多取5条关键思考）
    const thinkingSummary = [];
    for (const t of game.thinkingHistory ?? []) {
      const player = game.players?.[t.seatNo];
      const label = player ? `#${t.seatNo}(${player.role})` : `#${t.seatNo}`;
      const shortThinking = (t.thinking ?? "").slice(0, 200);
      thinkingSummary.push(`${label} [${t.phase}]: ${shortThinking}`);
    }

    const systemPrompt = [
      "你是阿瓦隆(Avalon)游戏的专业复盘分析师。",
      "请对以下对局进行全面深度分析，包括：",
      "1. 【对局概况】：简述整体局势走向",
      "2. 【关键转折点】：分析决定胜负的关键决策和事件",
      "3. 【各角色表现】：逐一评价每位玩家（AI）的表现，包括推理质量、欺骗水平、协作能力",
      "4. 【阵营分析】：好人阵营和坏人阵营各自的策略优劣",
      "5. 【AI决策评价】：评估各AI的决策质量，指出亮点和失误",
      "6. 【改进建议】：对各AI的策略提出改进建议",
      "7. 【总结评分】：给每位玩家打分（1-10），并给出MVP",
      "",
      "请用中文回答，分析要深入具体，引用实际游戏数据支撑观点。"
    ].join("\n");

    const userPrompt = [
      `【对局结果】${winnerText}`,
      `【比分】${scoreText}`,
      `【玩家角色】`,
      ...playerLines,
      `【场景描述】${game.scenario ?? "-"}`,
      `【关键事件时间线】`,
      ...eventSummary.slice(0, 50),
      `【AI思考过程摘要】`,
      ...thinkingSummary.slice(0, 30)
    ].join("\n");

    // 使用配置的LLM进行复盘分析
    const provider = normalizeProviderName(req.body?.provider ?? "doubao");
    const model = req.body?.model ?? null;
    const r = await llmChat({
      provider,
      model,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      roomId: null
    });

    if (r.ok && r.text) {
      res.json({ ok: true, review: r.text, usage: r.usage });
    } else {
      res.json({ ok: false, error: r.raw?.error ?? "llm_error", review: "" });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message ?? err) });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get("roomId");
  const token = url.searchParams.get("token");
  const room = rooms.get(roomId);
  if (!room) {
    ws.close(1008, "room_not_found");
    return;
  }
  const viewer = viewerFromToken(room, token);
  if (!viewer) {
    ws.close(1008, "unauthorized");
    return;
  }

  room.socketsByToken.set(token, ws);
  ws.on("close", () => {
    room.socketsByToken.delete(token);
  });

  const view = filterStateForViewer(room, viewer);
  ws.send(JSON.stringify({ type: "state", view }));
});

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST}:${PORT}`);
  const defaultTimeout = clampInt(process.env.LLM_TIMEOUT_MS, 1000, 300000, 60000);
  console.log(`[server] LLM default timeout: ${defaultTimeout}ms (env LLM_TIMEOUT_MS=${process.env.LLM_TIMEOUT_MS ?? "not set"})`);
  console.log(`[server] LLM request logs: ${LLM_REQUEST_LOG_PATH}`);
  // 打印各 provider 的超时配置
  for (const [p, cfg] of Object.entries(llmConfigStore)) {
    if (cfg.timeoutMs) {
      console.log(`[server] provider=${p} timeout=${cfg.timeoutMs}ms`);
    }
  }
});
