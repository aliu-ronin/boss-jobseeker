// Boss直聘求职助手 - Content Script
// Copyright (C) 2026 刘戈 <aliu.ronin@gmail.com>
// License: GPL-3.0 — see LICENSE file
// 运行在 zhipin.com/web/geek/chat 页面

const SCAN_INTERVAL = 30000;
const FIRST_SCAN_DELAY = 1000;

let processedIds = new Set();
let repliedIds = new Set();
let pendingRetry = new Map();
let followupSentDate = new Map();
const MAX_RETRY = 3;
let maxPerScan = 10;
let running = false;
let enabled = false;
let debugMode = false;
let savedState = null;
let statusText = "待命";
let scanIntervalId = null;
let firstRun = true;
let scanRound = 0;
let scanProgress = { current: 0, total: 0, evaluated: 0, skipped: 0, replied: 0 };
let nextScanAt = 0; // timestamp of next scan

let FOLLOWUP_MSG = "您好，感谢您的关注。当前消息由我的 AI 助理自动回复，您的信息已通知到我本人，我会尽快亲自与您联系，谢谢！";

// ── 与 background 通信 ──
async function callBg(action, data) {
  return chrome.runtime.sendMessage({ action, data });
}

async function checkReady() {
  try {
    const resp = await callBg("health");
    return resp?.configured || false;
  } catch { return false; }
}

// ── 日志 ──
function log(msg) { console.log(`[Boss助手] ${msg}`); }

// ── 提取当前页面的会话列表 ──
function extractChatList() {
  const items = [];
  const chatEls = document.querySelectorAll('li[role="listitem"]');

  chatEls.forEach((el, index) => {
    const nameBox = el.querySelector(".name-box");
    const spans = nameBox ? nameBox.querySelectorAll("span") : [];
    const name = el.querySelector(".name-text")?.textContent?.trim() || "";
    const company = spans.length >= 2 ? spans[1].textContent.trim() : "";
    const position = spans.length >= 3 ? spans[2].textContent.trim() : "";
    const lastMsg = el.querySelector(".last-msg-text")?.textContent?.trim() || "";
    const timeText = el.querySelector(".time-text, .msg-time, .time")?.textContent?.trim() || "";
    const hasUnread = !!el.querySelector(".notice-badge");
    // 优先使用 DOM 属性作为稳定 ID，fallback 用 name+company 生成确定性 ID
    const friendEl = el.querySelector(".friend-content");
    const domId = friendEl?.getAttribute("d-c") || friendEl?.getAttribute("data-c")
      || friendEl?.getAttribute("data-id") || friendEl?.getAttribute("data-uid") || "";
    const chatId = domId || (name && company ? `u_${name}_${company}_${position}` : `chat_${index}`);
    items.push({ index, chatId, name, company, position, salary: "", lastMsg, timeText, hasUnread, el });
  });
  return items;
}

// ── 提取当前打开的会话消息 ──
function extractMessages() {
  const msgs = [];
  document.querySelectorAll(".message-item").forEach((el) => {
    const isSelf = el.classList.contains("item-myself");
    const isFriend = el.classList.contains("item-friend");
    if (!isSelf && !isFriend) return;
    const textEl = el.querySelector("div.text");
    if (!textEl) return;
    const text = textEl.innerText.trim();
    if (text.length < 2) return;
    msgs.push({ text, isSelf });
  });
  return msgs.slice(-15);
}

// ── 点击会话项 ──
async function clickChat(chatItem) {
  const clickTarget = chatItem.el.querySelector(".friend-content") || chatItem.el;
  clickTarget.click();
  await sleep(3000);
}

// ── 检测并同意对方的简历索取请求 ──
async function acceptResumeRequest() {
  const popoverBtn = document.querySelector(".respond-popover .btn-agree");
  if (popoverBtn && popoverBtn.offsetParent !== null) {
    if (debugMode) { log("[调试] 检测到简历索取弹窗，模拟点击同意"); return true; }
    popoverBtn.click();
    await sleep(500);
    log("已同意对方的附件简历索取请求（弹窗）");
    return true;
  }
  const cardBtns = document.querySelectorAll(".message-card-buttons .card-btn");
  for (const btn of cardBtns) {
    if (btn.textContent.trim() === "同意" && btn.offsetParent !== null) {
      if (debugMode) { log("[调试] 检测到简历索取卡片，模拟点击同意"); return true; }
      btn.click();
      await sleep(500);
      log("已同意对方的附件简历索取请求（卡片）");
      return true;
    }
  }
  return false;
}

// ── 发送回复消息 ──
async function sendReply(text) {
  if (debugMode) { log(`[调试] 模拟发送消息: ${text.substring(0, 50)}...`); return true; }
  const inputSelectors = [
    ".chat-editor .chat-input", ".chat-editor [contenteditable]",
    ".message-controls [contenteditable]", ".chat-editor textarea",
    'textarea', '[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) { input = document.querySelector(sel); if (input) break; }
  if (!input) { log("未找到输入框"); return false; }

  input.focus(); input.click(); await sleep(300);

  if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
      || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (nativeSetter) { nativeSetter.call(input, text); } else { input.value = text; }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    input.textContent = text;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }
  await sleep(500);

  const sendSelectors = [
    ".chat-editor .btn-send", ".chat-editor [class*='send']",
    ".message-controls .btn-send", 'button[class*="btn-send"]', '[class*="send-btn"]',
  ];
  let sendBtn = null;
  for (const sel of sendSelectors) { try { sendBtn = document.querySelector(sel); if (sendBtn) break; } catch {} }
  if (!sendBtn) {
    const btns = document.querySelectorAll(".chat-editor button, .message-controls button, button");
    for (const btn of btns) { if (btn.textContent.trim() === "发送") { sendBtn = btn; break; } }
  }
  if (sendBtn) { sendBtn.click(); await sleep(500); log("消息已发送"); return true; }

  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  await sleep(500); log("消息已发送 (Enter)"); return true;
}

// ── 发送在线简历 ──
async function sendResume() {
  if (debugMode) { log("[调试] 模拟发送简历"); return true; }
  let toolBtn = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const btns = document.querySelectorAll(".toolbar-btn");
    for (const btn of btns) {
      if (btn.innerText.trim() === "发简历" && btn.offsetParent !== null) { toolBtn = btn; break; }
    }
    if (toolBtn) break;
    await sleep(500);
  }
  if (!toolBtn) {
    const allToolBtns = document.querySelectorAll(".toolbar-btn-content, .toolbar-btn");
    const names = [...allToolBtns].map((b) => `"${b.innerText.trim()}"`).join(", ");
    log(`未找到发简历按钮（等待5秒后放弃），当前工具栏: [${names}]`);
    return false;
  }
  toolBtn.click();
  log(`已点击发简历按钮: "${toolBtn.innerText.trim()}"`);

  let panel = null;
  for (let i = 0; i < 6; i++) {
    await sleep(500);
    panel = document.querySelector(".panel-resume, .sentence-popover, .dialog-resume, .dialog-layer, .resume-dialog, [class*='resume-pop'], [class*='resume-panel']");
    if (panel && panel.offsetParent !== null) break;
    panel = null;
  }
  if (panel) {
    log(`找到简历弹窗: class="${panel.className}"`);
    const confirmBtn = panel.querySelector(".btn-sure-v2, .btn-sure, .btn-primary, .btn-confirm, [class*='sure'], [class*='confirm']");
    if (confirmBtn) {
      log(`点击确认按钮: "${confirmBtn.textContent.trim()}" class="${confirmBtn.className}"`);
      confirmBtn.click(); await sleep(500); log("在线简历已发送"); return true;
    } else {
      const panelBtns = panel.querySelectorAll("button, .btn, [class*='btn']");
      const btnInfo = [...panelBtns].map((b) => `"${b.textContent.trim()}"(${b.className})`).join(", ");
      log(`弹窗内未找到确认按钮，弹窗内按钮: [${btnInfo}]`);
    }
  } else { log("未检测到简历确认弹窗（3秒超时）"); }

  const allBtns = document.querySelectorAll(".btn-sure-v2, .btn-v2, .btn-sure, .btn-primary, button");
  for (const btn of allBtns) {
    const txt = btn.textContent.trim();
    if ((txt === "确定" || txt === "发送" || txt === "确认" || txt === "发送简历") && btn.offsetParent !== null) {
      log(`fallback 点击: "${txt}" class="${btn.className}"`);
      btn.click(); await sleep(500); log("在线简历已发送 (fallback)"); return true;
    }
  }
  log("未找到确认发送按钮（所有路径均失败）");
  return false;
}

// ── 工具函数 ──
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function canSendFollowup(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  return followupSentDate.get(chatId) !== today;
}
function markFollowupSent(chatId) {
  followupSentDate.set(chatId, new Date().toISOString().slice(0, 10));
}

function extractSalary() {
  const el = document.querySelector(".chat-position-content .salary");
  return el ? el.textContent.trim() : "";
}
function extractCity() {
  const el = document.querySelector(".chat-position-content .city");
  return el ? el.textContent.trim() : "";
}
function extractJobTitle() {
  const el = document.querySelector(".chat-position-content .position-name");
  return el ? el.textContent.trim() : "";
}

function hasResumeInChat() {
  const resumeEls = document.querySelectorAll('.message-item [class*="resume"], .message-item .msg-resume, .message-item .resume-card');
  if (resumeEls.length > 0) return true;
  const msgItems = document.querySelectorAll(".message-item");
  for (const item of msgItems) {
    const text = item.textContent || "";
    if (text.includes("在线简历") || text.includes("已发送简历") || text.includes("附件简历")) return true;
  }
  return false;
}

function isWithin3Days(timeText) {
  if (!timeText) return true;
  if (timeText === "刚刚" || timeText.includes("分钟前") || timeText.includes("小时前")) return true;
  if (timeText === "昨天" || timeText === "前天") return true;
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const wIdx = weekdays.indexOf(timeText);
  if (wIdx >= 0) {
    const todayIdx = new Date().getDay();
    let diff = todayIdx - wIdx;
    if (diff <= 0) diff += 7;
    return diff <= 3;
  }
  const m = timeText.match(/(\d{4}[-/])?(\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const y = m[1] ? parseInt(m[1]) : new Date().getFullYear();
    const msgDate = new Date(y, parseInt(m[2]) - 1, parseInt(m[3]));
    return (Date.now() - msgDate.getTime()) / 86400000 <= 3;
  }
  return true;
}

// ── 主扫描循环 ──
async function scanOnce() {
  if (running || !enabled) return;
  running = true;

  scanRound++;
  scanProgress = { current: 0, total: 0, evaluated: 0, skipped: 0, replied: 0 };
  nextScanAt = 0;
  statusText = `第${scanRound}轮 | 检查配置...`;
  const ready = await checkReady();
  if (!ready) {
    log("未配置 API Key，跳过扫描");
    statusText = "未配置 API Key";
    running = false;
    return;
  }

  try {
    statusText = `第${scanRound}轮 | 扫描会话列表...`;
    const chatList = extractChatList();
    const unreadCount = chatList.filter((c) => c.hasUnread).length;
    log(`第${scanRound}轮开始: 共 ${chatList.length} 个会话, ${unreadCount} 个未读, ${pendingRetry.size} 个待重试, 缓存 ${processedIds.size} 条${debugMode ? " [调试模式]" : ""}`);

    // ── 1. 处理待重试的会话 ──
    if (pendingRetry.size > 0) {
      log(`有 ${pendingRetry.size} 条待重试会话`);
      for (const [chatId, info] of [...pendingRetry.entries()]) {
        if (info.retryCount >= MAX_RETRY) {
          log(`重试次数已达上限，放弃: ${info.company}`);
          pendingRetry.delete(chatId); processedIds.add(chatId); continue;
        }
        const chatItem = chatList.find((c) => c.chatId === chatId);
        if (!chatItem) continue;

        statusText = `重试: ${info.company}`;
        log(`重试发简历: ${info.company} (第${info.retryCount + 1}次)`);
        await clickChat(chatItem);
        await acceptResumeRequest();

        const retryMsgs = extractMessages();
        const alreadyReplied = retryMsgs.some((m) => m.isSelf);
        if (!alreadyReplied) {
          const sent = await sendReply(info.greeting);
          if (!sent) { info.retryCount++; log(`重试回复失败: ${info.company}`); await sleep(3000); continue; }
          await sleep(1000);
        }

        const resumeSent = await sendResume();
        if (resumeSent) {
          await sleep(1000);
          const verified = hasResumeInChat();
          if (verified) {
            repliedIds.add(chatId); pendingRetry.delete(chatId); processedIds.add(chatId);
            try { await callBg("notifySent", { chatId, company: info.company, position: info.position, salary: info.salary, score: info.score, reason: info.reason }); } catch {}
            log(`重试成功（已验证简历发出）: ${info.company}`);
          } else { info.retryCount++; log(`重试: sendResume返回成功但验证未通过，第${info.retryCount}次: ${info.company}`); }
        } else { info.retryCount++; log(`重试发简历失败: ${info.company}`); }
        await sleep(3000);
      }
    }

    // ── 2. 处理已回复会话的二次消息 ──
    const unreadFollowup = chatList.filter((c) => c.hasUnread && repliedIds.has(c.chatId));
    if (unreadFollowup.length > 0) {
      log(`发现 ${unreadFollowup.length} 条已回复会话的新消息`);
      for (const chat of unreadFollowup.slice(0, 3)) {
        await clickChat(chat);
        const fMsgs = extractMessages();
        const fBoss = fMsgs.filter((m) => !m.isSelf).map((m) => m.text);
        if (fBoss.length > 0) {
          try {
            const dResult = await callBg("detectInterview", {
              chatId: chat.chatId, company: chat.company, position: chat.position,
              jobTitle: extractJobTitle(), salary: extractSalary(), city: extractCity(),
              messages: fBoss.slice(-10), debug: debugMode,
            });
            if (dResult.is_interview) log(`检测到面试邀请: ${chat.company} | ${dResult.summary}`);
          } catch (e) { log(`面试检测失败: ${e.message}`); }
        }
        if (canSendFollowup(chat.chatId)) {
          const sent = await sendReply(FOLLOWUP_MSG);
          if (sent && !debugMode) markFollowupSent(chat.chatId);
          log(`已发送礼貌回复: ${chat.company}`);
        }
        await sleep(3000);
      }
    }

    // ── 3. 处理需要评估的会话 ──
    let _skipRetry = 0, _skipProcessed = 0, _skipOld = 0, _pass = 0;
    const toEvaluate = chatList.filter((c) => {
      if (debugMode) { if (!isWithin3Days(c.timeText)) return false; return true; }
      if (pendingRetry.has(c.chatId) || repliedIds.has(c.chatId)) { _skipRetry++; return false; }
      if (processedIds.has(c.chatId) && !c.hasUnread) { _skipProcessed++; return false; }
      if (!isWithin3Days(c.timeText)) { processedIds.add(c.chatId); _skipOld++; return false; }
      _pass++; return true;
    });
    log(`过滤结果: ${_pass} 通过, ${_skipProcessed} 已处理, ${_skipOld} 超3天, ${_skipRetry} 重试/已回复`);

    const batchSize = firstRun ? toEvaluate.length : maxPerScan;
    const actualBatch = Math.min(batchSize, toEvaluate.length);
    scanProgress.total = actualBatch;
    if (toEvaluate.length > 0) {
      statusText = `第${scanRound}轮 | 待评估 ${actualBatch} 条`;
      log(`发现 ${toEvaluate.length} 条待评估会话（3天内）${firstRun ? "，首轮全量扫" : `，本轮处理 ${actualBatch} 条`}`);
    } else if (pendingRetry.size === 0 && unreadFollowup.length === 0) {
      statusText = `第${scanRound}轮 | 无新会话 | 已处理 ${processedIds.size}`;
      log(`本轮无新会话需处理，${SCAN_INTERVAL / 1000}秒后下一轮`);
    }

    for (const chat of toEvaluate.slice(0, batchSize)) {
      if (!enabled) { log("已暂停，中断扫描"); break; }
      scanProgress.current++;
      statusText = `第${scanRound}轮 [${scanProgress.current}/${scanProgress.total}] ${chat.company}`;
      await clickChat(chat);

      const messages = extractMessages();
      const bossMessages = messages.filter((m) => !m.isSelf).map((m) => m.text);
      if (bossMessages.length === 0) {
        if (!debugMode) processedIds.add(chat.chatId);
        scanProgress.skipped++;
        log(`对方无消息，跳过: ${chat.company}`);
        await sleep(500); continue;
      }

      const salary = extractSalary();
      const city = extractCity();
      const jobTitle = extractJobTitle();

      const payload = {
        chatId: chat.chatId, company: chat.company, position: chat.position,
        jobTitle, salary, city, name: chat.name, lastMsg: chat.lastMsg,
        messages: bossMessages.slice(-5), debug: debugMode,
      };

      statusText = `第${scanRound}轮 [${scanProgress.current}/${scanProgress.total}] 评估: ${chat.company}`;
      log(`评估: ${chat.company} | ${jobTitle || chat.position} | ${salary || "薪资未知"} | ${city || "城市未知"}`);

      let result;
      try {
        result = await callBg("evaluate", payload);
        if (!result) throw new Error("无响应");
      } catch (e) { log(`评估请求失败: ${e.message}`); continue; }

      const score = result.score || 0;
      scanProgress.evaluated++;
      statusText = `第${scanRound}轮 [${scanProgress.current}/${scanProgress.total}] ${chat.company} ${score}分`;
      log(`结果: ${score}分 | ${result.reason} | ${result.action}`);
      if (result.detail) log(`明细: ${result.detail}`);

      // 对方婉拒：不匹配，直接跳过（未调 LLM，节省额度）
      if (result.type === "REJECT" || result.action === "REJECT") {
        if (!debugMode) processedIds.add(chat.chatId);
        scanProgress.skipped++;
        log(`对方婉拒，跳过: ${chat.company} | ${result.reason}`);
        await sleep(500); continue;
      }

      // 面试邀请：已进入面试流程，不再自动打招呼/发简历
      if (result.type === "INTERVIEW" || result.action === "INTERVIEW") {
        if (!debugMode) processedIds.add(chat.chatId);
        scanProgress.skipped++;
        log(`面试邀请，跳过自动回复: ${chat.company} | ${result.reason}`);
        await sleep(1000); continue;
      }

      if (score < 70) {
        if (!debugMode) processedIds.add(chat.chatId);
        scanProgress.skipped++;
        log(`${score}分 < 70，跳过: ${chat.company}`);
        await sleep(1000); continue;
      }

      const hasSelfMsg = messages.some((m) => m.isSelf);
      const hasResume = hasResumeInChat();

      // 已发过简历
      if (hasResume) {
        if (!debugMode) processedIds.add(chat.chatId);
        if (chat.hasUnread) {
          if (bossMessages.length > 0) {
            try {
              const dResult = await callBg("detectInterview", {
                chatId: chat.chatId, company: chat.company, position: chat.position,
                jobTitle, salary, city, messages: bossMessages.slice(-10), debug: debugMode,
              });
              if (dResult.is_interview) log(`${score}分 检测到面试邀请: ${chat.company} | ${dResult.summary}`);
            } catch (e) { log(`面试检测失败: ${e.message}`); }
          }
          if (canSendFollowup(chat.chatId)) {
            const sent = await sendReply(FOLLOWUP_MSG);
            if (sent && !debugMode) markFollowupSent(chat.chatId);
            log(`${score}分 已发简历+新消息，礼貌回复: ${chat.company}`);
          }
        } else { log(`${score}分 已发简历，无新消息，跳过: ${chat.company}`); }
        await sleep(1000); continue;
      }

      // 有自己消息但没简历 → 补发
      if (hasSelfMsg) {
        log(`${score}分 已有对话，补发简历: ${chat.company}`);
        await acceptResumeRequest();
        const resumeSent = await sendResume();
        if (resumeSent && !debugMode) { repliedIds.add(chat.chatId); processedIds.add(chat.chatId); scanProgress.replied++; }
        else if (!debugMode) { processedIds.add(chat.chatId); scanProgress.skipped++; }
        log(`补发简历${resumeSent ? "成功" : "失败"}: ${chat.company}`);
        await sleep(1000); continue;
      }

      // 全新会话 → 发招呼 + 发简历
      if (result.greeting) {
        const sent = await sendReply(result.greeting);
        if (sent) {
          await sleep(2000);
          await acceptResumeRequest();
          const resumeSent = await sendResume();
          if (resumeSent) {
            await sleep(1000);
            const verified = hasResumeInChat();
            if (verified) {
              if (!debugMode) { repliedIds.add(chat.chatId); processedIds.add(chat.chatId); scanProgress.replied++; }
              try { await callBg("notifySent", { chatId: chat.chatId, company: chat.company, position: chat.position, salary, score, reason: result.reason }); } catch {}
              log(`简历已发送（验证通过）: ${chat.company}`);
            } else {
              log(`sendResume返回成功但验证未通过，加入重试: ${chat.company}`);
              if (!debugMode) { pendingRetry.set(chat.chatId, { greeting: result.greeting, score, reason: result.reason, company: chat.company, position: chat.position, salary, retryCount: 1 }); }
            }
          } else if (!debugMode) {
            pendingRetry.set(chat.chatId, { greeting: result.greeting, score, reason: result.reason, company: chat.company, position: chat.position, salary, retryCount: 1 });
            log(`简历发送失败，加入重试队列: ${chat.company}`);
          }
        } else if (!debugMode) {
          pendingRetry.set(chat.chatId, { greeting: result.greeting, score, reason: result.reason, company: chat.company, position: chat.position, salary, retryCount: 1 });
          log(`回复发送失败，加入重试队列: ${chat.company}`);
        }
      } else if (!debugMode) { processedIds.add(chat.chatId); }
      await sleep(3000);
    }
  } catch (e) { log(`扫描异常: ${e.message}`); }

  if (firstRun) firstRun = false;
  nextScanAt = Date.now() + SCAN_INTERVAL;
  const sp = scanProgress;
  statusText = `第${scanRound}轮完成 | 评${sp.evaluated} 投${sp.replied} 跳${sp.skipped} | 已处理 ${processedIds.size}`;
  // 轮次摘要通知
  if (sp.evaluated > 0) {
    try { await callBg("notifyRoundSummary", { round: scanRound, evaluated: sp.evaluated, replied: sp.replied, skipped: sp.skipped, total: processedIds.size }); } catch {}
  }
  running = false;
}

// ── 手动启用 ──
async function startScanning() {
  if (enabled) return;
  enabled = true;

  const ready = await checkReady();
  if (!ready) {
    log("未配置 API Key，请在扩展配置中设置");
    enabled = false;
    return;
  }

  log("扩展已就绪，开始监控");
  try {
    const data = await callBg("getProcessed");
    if (data.completed && Array.isArray(data.completed)) {
      data.completed.forEach((id) => processedIds.add(id));
      if (data.pending && data.pending.length > 0) {
        data.pending.forEach((entry) => {
          pendingRetry.set(entry.chatId, {
            greeting: entry.greeting, score: entry.score, reason: entry.reason,
            company: entry.company, position: entry.position, salary: entry.salary,
            retryCount: 0,
          });
        });
        log(`待重试: ${data.pending.length} 条（简历未发送）`);
      }
    }
    log(`已加载 ${processedIds.size} 条已完成 + ${pendingRetry.size} 条待重试`);
  } catch {}

  try {
    const cfg = await callBg("getConfig");
    if (cfg.actions?.max_per_scan) maxPerScan = cfg.actions.max_per_scan;
    if (cfg.actions?.followup_template) FOLLOWUP_MSG = cfg.actions.followup_template;
    log(`配置: 每轮最多 ${maxPerScan} 条`);
  } catch {}

  log(`首次扫描将在 ${FIRST_SCAN_DELAY / 1000} 秒后开始`);
  setTimeout(() => {
    scanOnce();
    if (scanIntervalId) clearInterval(scanIntervalId);
    scanIntervalId = setInterval(scanOnce, SCAN_INTERVAL);
  }, FIRST_SCAN_DELAY);
}

// ── 启动 ──
async function init() {
  log("Boss直聘求职助手已加载（等待手动启动）");
  await sleep(1000);
  const ready = await checkReady();
  log(ready ? "扩展已就绪，请点击扩展图标 → 开始扫描" : "请先在扩展配置中设置 API Key");
}

// ── 监听 popup 消息 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "getStatus") {
    const countdown = nextScanAt > 0 ? Math.max(0, Math.round((nextScanAt - Date.now()) / 1000)) : 0;
    sendResponse({ ok: true, enabled, running, debugMode, statusText, processedCount: processedIds.size, pendingCount: pendingRetry.size, scanRound, scanProgress, countdown });
  } else if (msg.action === "start") {
    if (enabled) { sendResponse({ ok: true, msg: "已在运行中" }); }
    else { startScanning().then(() => sendResponse({ ok: true, msg: "已启动" })); return true; }
  } else if (msg.action === "stop") {
    enabled = false; firstRun = true;
    if (scanIntervalId) { clearInterval(scanIntervalId); scanIntervalId = null; }
    log("扫描已暂停（定时器已清除）");
    sendResponse({ ok: true, msg: "已暂停" });
  } else if (msg.action === "clearCache") {
    processedIds.clear(); repliedIds.clear(); pendingRetry.clear(); followupSentDate.clear();
    firstRun = true; scanRound = 0;
    scanProgress = { current: 0, total: 0, evaluated: 0, skipped: 0, replied: 0 };
    statusText = "缓存已清除，可重新扫描";
    log(`缓存已清除：processedIds/repliedIds/pendingRetry 全部重置`);
    sendResponse({ ok: true });
  } else if (msg.action === "scanNow") {
    if (running) { sendResponse({ ok: true, msg: "扫描正在进行中..." }); }
    else {
      sendResponse({ ok: true, msg: "已触发扫描" });
      const wasEnabled = enabled;
      enabled = true;
      scanOnce().finally(() => { if (!wasEnabled) enabled = false; });
    }
  } else if (msg.action === "toggleDebug") {
    debugMode = !debugMode;
    if (debugMode) {
      savedState = { processedIds: new Set(processedIds), repliedIds: new Set(repliedIds), pendingRetry: new Map(pendingRetry), followupSentDate: new Map(followupSentDate) };
      processedIds.clear(); repliedIds.clear(); pendingRetry.clear(); followupSentDate.clear();
      log("调试模式: 开启（状态已清空）");
      if (enabled && !running) setTimeout(scanOnce, 500);
    } else {
      if (savedState) {
        processedIds = savedState.processedIds; repliedIds = savedState.repliedIds;
        pendingRetry = savedState.pendingRetry; followupSentDate = savedState.followupSentDate;
        savedState = null;
        log(`调试模式: 关闭（已恢复，已处理 ${processedIds.size} 条）`);
      } else { log("调试模式: 关闭"); }
    }
    sendResponse({ ok: true, debugMode });
  }
});

// ── 调试函数 ──
window.__debugSendResume = async function () {
  log("[调试] 测试发送简历...");
  const ok = await sendResume();
  log(`[调试] 发简历结果: ${ok}`);
};
window.__debugReply = async function (text) {
  text = text || "测试消息，请忽略";
  log(`[调试] 测试发送消息: ${text}`);
  const ok = await sendReply(text);
  log(`[调试] 发消息结果: ${ok}`);
};
window.__debugFullFlow = async function () {
  log("[调试] 提取当前会话消息...");
  const msgs = extractMessages();
  log(`[调试] 提取到 ${msgs.length} 条消息`);
  msgs.forEach((m) => log(`  ${m.isSelf ? "我" : "Boss"}: ${m.text.substring(0, 50)}`));
  const bossMessages = msgs.filter((m) => !m.isSelf).map((m) => m.text);
  log("[调试] 发送评估请求...");
  try {
    const result = await callBg("evaluate", {
      chatId: "debug_test", company: "调试测试", position: "测试岗位",
      salary: "", name: "调试", lastMsg: bossMessages[bossMessages.length - 1] || "",
      messages: bossMessages.slice(-5),
    });
    log(`[调试] 评估结果: ${result.score}分 | ${result.reason} | ${result.action}`);
    if (result.detail) log(`[调试] 明细: ${result.detail}`);
  } catch (e) { log(`[调试] 评估失败: ${e.message}`); }
};

init();
