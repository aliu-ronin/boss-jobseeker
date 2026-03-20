// Boss直聘求职助手 - Popup UI
// Copyright (C) 2026 刘戈 <aliu.ronin@gmail.com>
// License: GPL-3.0 — see LICENSE file

const toggleBtn = document.getElementById("toggleBtn");
const debugBtn = document.getElementById("debugBtn");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

// ── 状态同步 ──
async function syncState() {
  let healthResp = {};
  try {
    healthResp = await chrome.runtime.sendMessage({ action: "health" }) || {};
  } catch {}

  // 更新降级提示
  const ruleHint = document.getElementById("ruleEngineHint");
  if (ruleHint) ruleHint.style.display = healthResp.hasLlm ? "none" : "block";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes("zhipin.com/web/geek/chat")) {
    statusEl.className = "status offline";
    statusEl.textContent = "请先打开 Boss直聘消息页";
    toggleBtn.textContent = "开始扫描"; toggleBtn.className = "";
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "getStatus" }, (resp) => {
    const pw = document.getElementById("progressWrap");
    const pf = document.getElementById("progressFill");
    const pi = document.getElementById("progressInfo");

    if (chrome.runtime.lastError || !resp) {
      statusEl.className = "status offline";
      statusEl.textContent = "扩展未就绪，请刷新页面";
      toggleBtn.textContent = "开始扫描"; toggleBtn.className = "";
      pw.style.display = "none";
      return;
    }
    debugBtn.textContent = resp.debugMode ? "调试模式：开" : "调试模式：关";
    debugBtn.className = resp.debugMode ? "danger" : "secondary";

    if (!resp.enabled) {
      statusEl.className = "status paused";
      statusEl.textContent = `已暂停 | 已处理 ${resp.processedCount} 条`;
      toggleBtn.textContent = "开始扫描"; toggleBtn.className = "";
      pw.style.display = "none";
      return;
    }

    // ── enabled = true ──
    const tag = resp.debugMode ? " [调试]" : "";
    toggleBtn.textContent = "暂停扫描"; toggleBtn.className = "danger";
    pw.style.display = "block";
    const sp = resp.scanProgress || { current: 0, total: 0, evaluated: 0, replied: 0, skipped: 0 };
    const rd = resp.scanRound || 0;

    const bar = pf.parentElement; // .progress-bar

    if (resp.running) {
      // 正在扫描
      statusEl.className = "status online";
      statusEl.textContent = `${resp.statusText}${tag}`;
      if (sp.total > 0) {
        // 从等待切到扫描：先跳到 0% 再增长
        if (bar.classList.contains("waiting")) {
          bar.classList.remove("waiting");
          pf.style.transition = "none";
          pf.style.width = "0%";
          pf.offsetHeight; // force reflow
          pf.style.transition = "width 0.5s ease";
        }
        const pct = Math.round(sp.current / sp.total * 100);
        pf.style.width = pct + "%";
        pi.textContent = `进度 ${sp.current}/${sp.total} | 评估 ${sp.evaluated} | 投递 ${sp.replied} | 跳过 ${sp.skipped}`;
      } else {
        bar.classList.add("waiting");
        pi.textContent = `第${rd}轮扫描中...`;
      }
    } else {
      // 轮间等待 → 滑动条纹
      statusEl.className = resp.debugMode ? "status paused" : "status online";
      bar.classList.add("waiting");
      const cd = resp.countdown > 0 ? resp.countdown : 0;
      let info = `第${rd}轮完成`;
      if (sp.evaluated > 0) info += ` | 评估 ${sp.evaluated} | 投递 ${sp.replied} | 跳过 ${sp.skipped}`;
      info += ` | 已处理 ${resp.processedCount}`;
      if (cd > 0) {
        statusEl.textContent = `等待下一轮 ${cd}s${tag}`;
        info += ` | ${cd}s 后第${rd + 1}轮`;
      } else {
        statusEl.textContent = `${resp.statusText}${tag}`;
      }
      pi.textContent = info;
    }
  });
}

// ── 操作按钮 ──
toggleBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes("zhipin.com/web/geek/chat")) {
    statusEl.textContent = "请先打开 Boss直聘消息页"; return;
  }
  const action = toggleBtn.textContent === "暂停扫描" ? "stop" : "start";
  chrome.tabs.sendMessage(tab.id, { action }, (resp) => {
    if (chrome.runtime.lastError || !resp) { statusEl.textContent = "请刷新Boss直聘页面后重试"; return; }
    syncState();
  });
});

document.getElementById("scanNowBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes("zhipin.com/web/geek/chat")) {
    statusEl.textContent = "请先打开 Boss直聘消息页"; return;
  }
  chrome.tabs.sendMessage(tab.id, { action: "scanNow" }, (resp) => {
    if (chrome.runtime.lastError || !resp) { statusEl.textContent = "请刷新Boss直聘页面后重试"; return; }
    statusEl.className = "status online";
    statusEl.textContent = resp.msg;
    syncState();
  });
});

debugBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url.includes("zhipin.com/web/geek/chat")) return;
  chrome.tabs.sendMessage(tab.id, { action: "toggleDebug" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    debugBtn.textContent = resp.debugMode ? "调试模式：开" : "调试模式：关";
    debugBtn.className = resp.debugMode ? "danger" : "secondary";
    syncState();
  });
});

// ── 清除缓存 ──
document.getElementById("clearCacheBtn").addEventListener("click", async () => {
  if (!confirm("确定清除所有处理记录？清除后所有会话将重新扫描评估。")) return;
  try {
    const data = await chrome.runtime.sendMessage({ action: "clearProcessed" });
    // 通知 content script 清除内存缓存
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url.includes("zhipin.com/web/geek/chat")) {
      chrome.tabs.sendMessage(tab.id, { action: "clearCache" });
    }
    statusEl.className = "status online";
    statusEl.textContent = `已清除 ${data.cleared || 0} 条记录，可重新扫描`;
    statsEl.innerHTML = "";
  } catch { statusEl.textContent = "清除失败"; }
});

// ── 统计 ──
document.getElementById("statusBtn").addEventListener("click", async () => {
  try {
    const data = await chrome.runtime.sendMessage({ action: "getStats" });
    let html = `面试: ${data.stats?.INTERVIEW || 0} | ` +
      `投递: ${data.stats?.REPLY || 0} | ` +
      `婉拒: ${data.stats?.REJECT || 0} | ` +
      `跳过: ${data.stats?.IGNORE || 0} | ` +
      `总计: ${data.total || 0}`;
    if (data.recent_all && data.recent_all.length > 0) {
      html += `<div style="margin-top:8px;border-top:1px solid #eee;padding-top:6px">`;
      for (const item of data.recent_all) {
        const color = item.action === "REPLY" ? "#2e7d32" : item.action === "INTERVIEW" ? "#d32f2f" : item.action === "REJECT" ? "#e65100" : "#999";
        const title = item.jobTitle || item.position || "";
        const city = item.city ? `[${item.city}]` : "";
        const sal = item.salary ? ` ${item.salary}` : "";
        html += `<div style="margin:4px 0;font-size:12px">` +
          `<span style="color:${color}">${item.score}分</span> ` +
          `<b>${item.company || "?"}</b> ${title}${sal} ${city} ` +
          `<span style="color:#888">${item.reason || ""}</span></div>`;
      }
      html += `</div>`;
    }
    statsEl.innerHTML = html;
  } catch { statsEl.textContent = "无法获取统计"; }
});

// ── 配置面板 ──
const configPanel = document.getElementById("configPanel");
const configBtn = document.getElementById("configBtn");
let providersData = {};
let configLoaded = false;

configBtn.addEventListener("click", async () => {
  const isOpen = configPanel.classList.contains("show");
  if (isOpen) { configPanel.classList.remove("show"); configBtn.textContent = "配置"; return; }
  configPanel.classList.add("show");
  configBtn.textContent = "收起配置";
  if (configLoaded) return;
  await loadConfig();
});

async function loadConfig() {
  try {
    const cfg = await chrome.runtime.sendMessage({ action: "getConfig" });

    document.getElementById("cfgName").value = cfg.identity?.name || "";
    document.getElementById("cfgRole").value = cfg.identity?.current_role || "";
    document.getElementById("cfgCompany").value = cfg.identity?.current_company || "";
    document.getElementById("cfgYears").value = cfg.identity?.experience_years || 10;
    document.getElementById("cfgTechStack").value = (cfg.identity?.tech_stack || []).join(", ");

    document.getElementById("cfgBaseline").value = cfg.filters?.salary_baseline_k ?? 500;
    document.getElementById("cfgCities").value = (cfg.filters?.cities || []).join(", ");
    document.getElementById("cfgBlacklist").value = (cfg.filters?.blacklist_industries || []).join(", ");
    document.getElementById("cfgOutsource").value = cfg.filters?.accept_outsource ? "1" : "0";
    document.getElementById("cfgThreshold").value = cfg.actions?.auto_reply_threshold ?? 70;
    document.getElementById("cfgMaxScan").value = cfg.actions?.max_per_scan ?? 10;

    // 评分调节
    const sc = cfg.scoring || {};
    document.getElementById("cfgScOutsource").value = sc.outsource ?? -100;
    document.getElementById("cfgSc996").value = sc.s996 ?? -20;
    document.getElementById("cfgScInfo").value = sc.info_insufficient ?? -50;
    document.getElementById("cfgScAiMatch").value = sc.ai_match ?? 10;
    document.getElementById("cfgScAiNo").value = sc.ai_nomatch ?? -5;
    document.getElementById("cfgScRecruiter").value = sc.recruiter_contact ?? 5;
    document.getElementById("cfgScFamous").value = sc.famous_company ?? 10;
    document.getElementById("cfgScPublic").value = sc.public_company ?? 5;

    document.getElementById("cfgGreeting").value = cfg.actions?.greeting_template || "";
    document.getElementById("cfgFollowup").value = cfg.actions?.followup_template || "";

    providersData = cfg.providers || {};
    const providerSel = document.getElementById("cfgProvider");
    providerSel.innerHTML = "";
    for (const [key, info] of Object.entries(providersData)) {
      const opt = document.createElement("option");
      opt.value = key; opt.textContent = info.name;
      providerSel.appendChild(opt);
    }
    providerSel.value = cfg.llm?.provider || "glm";
    fillModels(providerSel.value, cfg.llm?.model);
    document.getElementById("cfgApiUrl").value = cfg.llm?.api_url || "";
    document.getElementById("cfgApiKey").value = cfg.llm?.api_key || "";
    updateProviderNote(providerSel.value);

    // OpenClaw
    document.getElementById("cfgOcEnabled").value = cfg.openclaw?.enabled ? "1" : "0";
    document.getElementById("cfgOcUrl").value = cfg.openclaw?.gateway_url || "http://127.0.0.1:18789";
    document.getElementById("cfgOcToken").value = cfg.openclaw?.token || "";
    document.getElementById("cfgOcReply").checked = cfg.openclaw?.notify_reply !== false;
    document.getElementById("cfgOcInterview").checked = cfg.openclaw?.notify_interview !== false;
    document.getElementById("cfgOcSummary").checked = cfg.openclaw?.notify_summary || false;

    configLoaded = true;
  } catch { statusEl.textContent = "加载配置失败"; }
}

function fillModels(provider, currentModel) {
  const modelSel = document.getElementById("cfgModel");
  modelSel.innerHTML = "";
  const presets = providersData[provider]?.models || [];
  const allModels = new Set(presets);
  if (currentModel) allModels.add(currentModel);
  for (const m of allModels) {
    const opt = document.createElement("option");
    opt.value = m; opt.textContent = m;
    modelSel.appendChild(opt);
  }
  const customOpt = document.createElement("option");
  customOpt.value = "__custom__"; customOpt.textContent = "自定义...";
  modelSel.appendChild(customOpt);
  if (currentModel && allModels.has(currentModel)) modelSel.value = currentModel;
}

function updateProviderNote(provider) {
  document.getElementById("providerNote").textContent = providersData[provider]?.note || "";
}

document.getElementById("cfgProvider").addEventListener("change", (e) => {
  const p = e.target.value;
  const info = providersData[p];
  if (info) {
    document.getElementById("cfgApiUrl").value = info.api_url;
    fillModels(p, info.models[0]);
    document.getElementById("cfgModel").value = info.models[0];
  }
  updateProviderNote(p);
});

document.getElementById("cfgModel").addEventListener("change", (e) => {
  if (e.target.value === "__custom__") {
    const custom = prompt("输入自定义模型名称:");
    if (custom) {
      const opt = document.createElement("option");
      opt.value = custom; opt.textContent = custom;
      e.target.insertBefore(opt, e.target.lastChild);
      e.target.value = custom;
    } else { e.target.value = e.target.options[0]?.value || ""; }
  }
});

document.getElementById("toggleKeyEye").addEventListener("click", () => {
  const inp = document.getElementById("cfgApiKey");
  inp.type = inp.type === "password" ? "text" : "password";
});

document.getElementById("toggleOcEye").addEventListener("click", () => {
  const inp = document.getElementById("cfgOcToken");
  inp.type = inp.type === "password" ? "text" : "password";
});

// ── 保存 ──
document.getElementById("saveConfigBtn").addEventListener("click", async () => {
  const modelVal = document.getElementById("cfgModel").value;
  const payload = {
    identity: {
      name: document.getElementById("cfgName").value,
      current_role: document.getElementById("cfgRole").value,
      current_company: document.getElementById("cfgCompany").value,
      experience_years: parseInt(document.getElementById("cfgYears").value) || 10,
      tech_stack: document.getElementById("cfgTechStack").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    },
    filters: {
      salary_baseline_k: parseInt(document.getElementById("cfgBaseline").value) || 500,
      cities: document.getElementById("cfgCities").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      blacklist_industries: document.getElementById("cfgBlacklist").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      accept_outsource: document.getElementById("cfgOutsource").value === "1",
    },
    scoring: {
      outsource: parseInt(document.getElementById("cfgScOutsource").value),
      s996: parseInt(document.getElementById("cfgSc996").value),
      info_insufficient: parseInt(document.getElementById("cfgScInfo").value),
      ai_match: parseInt(document.getElementById("cfgScAiMatch").value),
      ai_nomatch: parseInt(document.getElementById("cfgScAiNo").value),
      famous_company: parseInt(document.getElementById("cfgScFamous").value),
      public_company: parseInt(document.getElementById("cfgScPublic").value),
      recruiter_contact: parseInt(document.getElementById("cfgScRecruiter").value),
    },
    actions: {
      auto_reply_threshold: parseInt(document.getElementById("cfgThreshold").value) || 70,
      max_per_scan: parseInt(document.getElementById("cfgMaxScan").value) || 10,
      greeting_template: document.getElementById("cfgGreeting").value,
      followup_template: document.getElementById("cfgFollowup").value,
    },
    llm: {
      provider: document.getElementById("cfgProvider").value,
      api_url: document.getElementById("cfgApiUrl").value,
      api_key: document.getElementById("cfgApiKey").value,
      model: modelVal === "__custom__" ? "" : modelVal,
    },
    openclaw: {
      enabled: document.getElementById("cfgOcEnabled").value === "1",
      gateway_url: document.getElementById("cfgOcUrl").value,
      token: document.getElementById("cfgOcToken").value,
      notify_reply: document.getElementById("cfgOcReply").checked,
      notify_interview: document.getElementById("cfgOcInterview").checked,
      notify_summary: document.getElementById("cfgOcSummary").checked,
    },
  };

  try {
    const data = await chrome.runtime.sendMessage({ action: "saveConfig", data: payload });
    if (data.ok) {
      const msg = document.getElementById("saveMsg");
      msg.style.display = "block";
      setTimeout(() => { msg.style.display = "none"; }, 2000);
    }
  } catch { alert("保存失败"); }
});

// ── 打赏 ──
document.getElementById("donateBtn").addEventListener("click", () => {
  const panel = document.getElementById("donatePanel");
  const btn = document.getElementById("donateBtn");
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  btn.textContent = isOpen ? "打赏作者" : "收起";
});

syncState();
setInterval(syncState, 2000);
