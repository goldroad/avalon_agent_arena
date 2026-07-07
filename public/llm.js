const $ = (id) => document.getElementById(id);

const PROVIDERS = ["custom", "deepseek", "xiaomi", "aliyun", "doubao", "kimi"];
const MASKED_KEY = "************";
const testOutMap = new Map(); // provider -> testOut DOM 元素
const PROVIDER_META = {
  custom: { mark: "CU", name: "Custom", sub: "自定义兼容网关", bg: "linear-gradient(135deg, #5d6bff, #7d4dff)", glow: "rgba(93,107,255,.28)" },
  deepseek: { mark: "DS", name: "DeepSeek", sub: "深度推理", bg: "linear-gradient(135deg, #2563eb, #06b6d4)", glow: "rgba(37,99,235,.28)" },
  xiaomi: { mark: "XM", name: "Xiaomi", sub: "小米大模型", bg: "linear-gradient(135deg, #ff7a18, #ff4d00)", glow: "rgba(255,122,24,.28)" },
  aliyun: { mark: "AY", name: "Aliyun", sub: "通义 / 云服务", bg: "linear-gradient(135deg, #5b8cff, #2dd4bf)", glow: "rgba(91,140,255,.28)" },
  doubao: { mark: "DB", name: "Doubao", sub: "字节豆包", bg: "linear-gradient(135deg, #14b8a6, #22c55e)", glow: "rgba(20,184,166,.28)" },
  kimi: { mark: "KM", name: "Kimi", sub: "Moonshot", bg: "linear-gradient(135deg, #111827, #4b5563)", glow: "rgba(156,163,175,.22)" }
};

async function getJson(url) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

async function postJson(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

function setStatus(text) {
  $("statusPill").textContent = text;
}

// 为自定义 provider 生成随机颜色
function getCustomProviderMeta(name) {
  const colors = [
    ["#6366f1", "#8b5cf6"], ["#f59e0b", "#ef4444"], ["#10b981", "#3b82f6"],
    ["#ec4899", "#f97316"], ["#8b5cf6", "#06b6d4"], ["#14b8a6", "#84cc16"],
    ["#e11d48", "#fb923c"], ["#7c3aed", "#2563eb"]
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffffff;
  const [c1, c2] = colors[hash % colors.length];
  const mark = name.slice(0, 2).toUpperCase();
  return { mark, name, sub: "自定义模型", bg: `linear-gradient(135deg, ${c1}, ${c2})`, glow: `${c1}44` };
}

function renderProviderCard(provider, status) {
  const meta = status.isCustom ? getCustomProviderMeta(provider) : (PROVIDER_META[provider] ?? PROVIDER_META.custom);
  const card = el("div", { className: "card provider-card", style: `--provider-bg:${meta.bg};--provider-glow:${meta.glow};` });
  
  // 构建头部，如果有失败状态则显示警告
  const headerChildren = [
    el("div", { className: "provider-brand" }, [
      el("div", { className: "provider-logo mono", text: meta.mark }),
      el("div", {}, [
        el("div", { className: "provider-name", text: meta.name }),
        el("div", { className: "provider-sub", text: meta.sub })
      ])
    ])
  ];
  
  // 如果有失败计数，显示失败状态标签
  if (status.failureCount > 0) {
    const failLabel = status.disabled 
      ? `⚠ 已禁用 (${status.failureCount}次失败)` 
      : `⚠ 失败 ${status.failureCount} 次`;
    const failPill = el("span", { 
      className: `pill mono ${status.disabled ? "pill-danger" : "pill-warn"}`, 
      text: failLabel 
    });
    headerChildren.push(failPill);
  }
  
  headerChildren.push(el("span", { className: "pill mono", text: provider }));
  
  const header = el("div", { className: "provider-head" }, headerChildren);
  card.appendChild(header);

  // 如果 provider 被禁用，添加提示信息
  if (status.disabled) {
    const disabledTip = el("div", { 
      className: "tip-box tip-warning", 
      html: `⚠ 该模型连续失败 ${status.failureCount} 次，已被自动禁用。<br>游戏运行时将自动切换到 doubao，避免浪费时间。<br>保存或测试配置后将自动重置。`
    });
    card.appendChild(disabledTip);
  }

  const kv = el("div", { className: "kv" }, [
    el("span", { className: "pill mono", text: `source=${status.source}` }),
    el("span", { className: "pill mono", text: `baseUrl=${status.hasBaseUrl}` }),
    el("span", { className: "pill mono", text: `apiKey=${status.hasApiKey}` }),
    el("span", { className: "pill mono", text: `model=${status.hasModel}` })
  ]);
  card.appendChild(kv);

  const baseUrlInput = el("input", { placeholder: "BASE_URL（OpenAI兼容根地址）", style: "flex:1" });
  const modelInput = el("input", { placeholder: "MODEL", style: "flex:1" });
  const apiKeyInput = el("input", { placeholder: "API_KEY（已保存时显示星号）", type: "password", style: "flex:1" });
  const tip = el("div", { className: "muted mono", text: "-" });
  const testOut = el("div", { className: "muted mono", text: "" });
  testOutMap.set(provider, testOut); // 注册到全局 map，供一键测试使用
  let apiKeyDirty = false;

  apiKeyInput.addEventListener("input", () => {
    apiKeyDirty = true;
  });

  const row1 = el("div", { className: "row", style: "margin-top:10px" }, [baseUrlInput]);
  const row2 = el("div", { className: "row", style: "margin-top:10px" }, [modelInput]);
  const row3 = el("div", { className: "row", style: "margin-top:10px" }, [apiKeyInput]);

  const saveBtn = el("button", { className: "primary" });
  saveBtn.textContent = "保存";
  const testBtn = el("button");
  testBtn.textContent = "连接测试";
  const clearBtn = el("button");
  clearBtn.textContent = "清除KEY";
  const reloadBtn = el("button");
  reloadBtn.textContent = "刷新";

  const btnRow = el("div", { className: "row", style: "margin-top:10px" }, [saveBtn, testBtn, clearBtn, reloadBtn]);

  async function load() {
    const cfg = await getJson(`/api/llm/config?provider=${encodeURIComponent(provider)}`);
    baseUrlInput.value = cfg.config.baseUrl ?? "";
    modelInput.value = cfg.config.model ?? "";
    apiKeyInput.value = cfg.config.apiKeyMasked ?? "";
    apiKeyDirty = false;
    tip.textContent = `envKeys=${(cfg.config.envKeys ?? []).join(",")} hasApiKey=${cfg.config.hasApiKey} source=${cfg.config.source}`;
    testOut.textContent = "";
  }

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const apiKey = apiKeyDirty && apiKeyInput.value !== MASKED_KEY ? apiKeyInput.value : "";
      await postJson("/api/llm/config", {
        provider,
        baseUrl: baseUrlInput.value,
        model: modelInput.value,
        apiKey
      });
      await load();
      setStatus(`已保存 ${provider}`);
      // 保存成功后刷新整个页面以更新失败状态显示
      setTimeout(() => main(), 100);
    } catch (e) {
      setStatus(`保存失败：${e.message}`);
    } finally {
      saveBtn.disabled = false;
    }
  };

  testBtn.onclick = async () => {
    testBtn.disabled = true;
    try {
      const apiKey = apiKeyDirty && apiKeyInput.value !== MASKED_KEY ? apiKeyInput.value : "";
      const r = await postJson("/api/llm/test", {
        provider,
        baseUrl: baseUrlInput.value,
        model: modelInput.value,
        apiKey
      });
      const t = r.test;
      const cls = t.success ? "ok" : "bad";
      testOut.innerHTML = `<span class="${cls}">success=${t.success}</span> httpOk=${t.httpOk} elapsedMs=${t.elapsedMs} sample=${escapeHtml(t.sample ?? "")} error=${escapeHtml(t.error ?? "")}`;
      setStatus(`已测试 ${provider}`);
    } catch (e) {
      testOut.innerHTML = `<span class="bad">test_failed</span> ${escapeHtml(e.message)}`;
      setStatus(`测试失败：${e.message}`);
    } finally {
      testBtn.disabled = false;
    }
  };

  clearBtn.onclick = async () => {
    clearBtn.disabled = true;
    try {
      await postJson("/api/llm/config", { provider, clearApiKey: true });
      apiKeyInput.value = "";
      apiKeyDirty = false;
      await load();
      setStatus(`已清除 ${provider} KEY`);
    } catch (e) {
      setStatus(`清除失败：${e.message}`);
    } finally {
      clearBtn.disabled = false;
    }
  };

  reloadBtn.onclick = async () => {
    reloadBtn.disabled = true;
    try {
      await load();
      setStatus(`已刷新 ${provider}`);
    } catch (e) {
      setStatus(`刷新失败：${e.message}`);
    } finally {
      reloadBtn.disabled = false;
    }
  };

  card.appendChild(row1);
  card.appendChild(row2);
  card.appendChild(row3);
  card.appendChild(btnRow);
  card.appendChild(el("div", { className: "tip-box muted" }, [tip]));
  card.appendChild(el("div", { className: "test-box" }, [testOut]));

  load().catch((e) => {
    tip.textContent = `load_failed: ${e.message}`;
  });

  return card;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// 一键测试所有模型（并行测试，结果显示在各自卡片下方）
async function testAllProviders() {
  const btn = $("testAllBtn");
  if (!btn) return;
  
  btn.disabled = true;
  btn.textContent = "测试中...";
  setStatus("一键测试中...");
  
  // 获取当前所有 provider 列表（包括自定义）
  const j = await getJson("/api/llm/providers");
  const allProviders = (j.providers ?? []).map(p => p.provider);
  
  // 先清空所有卡片的测试输出
  for (const provider of allProviders) {
    const out = testOutMap.get(provider);
    if (out) out.innerHTML = `<span class="muted">测试中...</span>`;
  }
  
  // 并行发起所有测试
  const tasks = allProviders.map(async (provider) => {
    const out = testOutMap.get(provider);
    try {
      // 获取配置判断是否已配置
      const cfg = await getJson(`/api/llm/config?provider=${encodeURIComponent(provider)}`);
      const config = cfg.config ?? {};
      if (!config.baseUrl && !config.model) {
        if (out) out.innerHTML = `<span class="muted">⏭ 未配置 baseUrl/model，已跳过</span>`;
        return { provider, success: false, skipped: true };
      }
      
      // 执行连接测试
      const r = await postJson("/api/llm/test", { provider });
      const t = r.test ?? {};
      const cls = t.success ? "ok" : "bad";
      if (out) {
        out.innerHTML = `<span class="${cls}">success=${t.success}</span> httpOk=${t.httpOk} elapsedMs=${t.elapsedMs} sample=${escapeHtml(t.sample ?? "")} error=${escapeHtml(t.error ?? "")}`;
      }
      return { provider, success: t.success ?? false, skipped: false };
    } catch (e) {
      if (out) out.innerHTML = `<span class="bad">test_failed</span> ${escapeHtml(e.message)}`;
      return { provider, success: false, skipped: false, error: e.message };
    }
  });
  
  const results = await Promise.all(tasks);
  
  const okCount = results.filter(r => r.success).length;
  const skipCount = results.filter(r => r.skipped).length;
  const failCount = results.filter(r => !r.success && !r.skipped).length;
  setStatus(`一键测试完成: ${okCount} 成功, ${failCount} 失败, ${skipCount} 跳过`);
  
  btn.disabled = false;
  btn.textContent = "一键测试";
}

// 初始化添加自定义模型表单
function initAddCustomForm() {
  const addBtn = $("addCustomBtn");
  const clearFormBtn = $("clearCustomFormBtn");
  const msgDiv = $("customMsg");
  
  if (!addBtn) return;
  
  addBtn.addEventListener("click", async () => {
    const name = $("customProviderName")?.value?.trim();
    const baseUrl = $("customBaseUrl")?.value?.trim();
    const model = $("customModel")?.value?.trim();
    const apiKey = $("customApiKey")?.value?.trim();
    
    // 验证输入
    if (!name) {
      msgDiv.innerHTML = `<span class="bad">请输入服务商名称</span>`;
      return;
    }
    if (!/^[a-z0-9][a-z0-9\-_]{2,49}$/i.test(name)) {
      msgDiv.innerHTML = `<span class="bad">服务商名称格式错误：仅允许字母、数字、短横线、下划线，且长度为3-50</span>`;
      return;
    }
    if (!baseUrl && !model) {
      msgDiv.innerHTML = `<span class="bad">请至少填写 BASE_URL 或 MODEL</span>`;
      return;
    }
    
    const providerKey = name.toLowerCase();
    addBtn.disabled = true;
    try {
      // 保存配置到后端
      await postJson("/api/llm/config", {
        provider: providerKey,
        baseUrl,
        model,
        apiKey
      });
      
      msgDiv.innerHTML = `<span class="ok">✓ 自定义模型 "${name}" 已保存</span>`;
      
      // 清空表单
      $("customProviderName").value = "";
      $("customBaseUrl").value = "";
      $("customModel").value = "";
      $("customApiKey").value = "";
      
      // 刷新页面以显示新添加的自定义模型
      setTimeout(() => main(), 200);
    } catch (e) {
      msgDiv.innerHTML = `<span class="bad">保存失败：${escapeHtml(e.message)}</span>`;
    } finally {
      addBtn.disabled = false;
    }
  });
  
  clearFormBtn?.addEventListener("click", () => {
    $("customProviderName").value = "";
    $("customBaseUrl").value = "";
    $("customModel").value = "";
    $("customApiKey").value = "";
    msgDiv.textContent = "";
  });
}

async function main() {
  setStatus("加载中...");
  const j = await getJson("/api/llm/providers");
  const statusByProvider = new Map((j.providers ?? []).map((x) => [x.provider, x]));

  const grid = $("providerGrid");
  grid.innerHTML = "";
  // 渲染所有 providers（包括内置和自定义）
  for (const st of (j.providers ?? [])) {
    grid.appendChild(renderProviderCard(st.provider, st));
  }
  setStatus("就绪");
  
  // 绑定一键测试按钮（只绑定一次）
  const testAllBtn = $("testAllBtn");
  if (testAllBtn && !testAllBtn._bound) {
    testAllBtn.addEventListener("click", testAllProviders);
    testAllBtn._bound = true;
  }
  
  // 初始化添加自定义模型表单（只绑定一次）
  initAddCustomForm();
}

main().catch((e) => {
  setStatus(`加载失败：${e.message}`);
});
