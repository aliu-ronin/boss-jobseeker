// Boss直聘求职助手 - Background Service Worker (Manifest V3)
// Copyright (C) 2026 刘戈 <aliu.ronin@gmail.com>
// License: GPL-3.0 — see LICENSE file
// 完全脱离 Python 服务，所有 LLM 调用/配置/数据持久化在此处理

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleString("zh-CN", { hour12: false }); }
function fillPrompt(tpl, params) {
  for (const [key, val] of Object.entries(params)) {
    tpl = tpl.replaceAll(`{${key}}`, String(val));
  }
  return tpl;
}

// ── LLM 提供商预设 ──
const LLM_PROVIDERS = {
  glm: {
    name: "智谱 GLM (Coding)",
    api_url: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    models: ["GLM-5", "GLM-5-Turbo", "GLM-4.7", "GLM-4.6", "GLM-4.5", "GLM-4.5-Air"],
    format: "openai",
    note: "Coding 套餐端点；GLM-5/5-Turbo 为高阶模型，额度消耗 2-3 倍",
  },
  openai: {
    name: "OpenAI",
    api_url: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"],
    format: "openai",
  },
  claude: {
    name: "Anthropic Claude",
    api_url: "https://api.anthropic.com/v1/messages",
    models: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001"],
    format: "claude",
    note: "价格较高，需在 console.anthropic.com 获取 API Key",
  },
  gemini: {
    name: "Google Gemini",
    api_url: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    format: "gemini",
  },
  minimax: {
    name: "MiniMax (Coding)",
    api_url: "https://api.minimaxi.com/anthropic/v1/messages",
    models: ["MiniMax-M2.7-highspeed", "MiniMax-M2.7", "MiniMax-M2.5-highspeed", "MiniMax-M2.5", "MiniMax-M2.1-highspeed", "MiniMax-M2.1", "MiniMax-M2"],
    format: "claude",
    note: "Coding 套餐端点（Anthropic 兼容格式），需使用 Coding Plan Key",
  },
};

function buildEvalPrompt(config) {
  const sc = config.scoring || DEFAULT_CONFIG.scoring;
  const acceptOut = config.filters?.accept_outsource || false;
  const outsourceRule = acceptOut
    ? `12. **外包/外派/驻场/人力外包** = 0（已设置接受外包）`
    : `12. **外包/外派/驻场/人力外包** = ${sc.outsource}`;

  return `你是一个求职顾问。判断这条消息是否值得回复。

## 求职者信息
- 姓名：{name}
- 当前：{role} @ {company}
- 年限：{years}年
- 技术栈：{stack}
- 目标城市：{cities}
- 拒绝行业：{blacklist}

## 薪资计分（最核心标准）
薪资换算规则：
- 格式 "xK-yK·N薪" → 年薪 = (x+y)/2 × N，例如 "40-60K·14薪" → (40+60)/2 × 14 = 700K
- 格式 "xK-yK" 无N薪标注 → 年薪 = (x+y)/2 × 12
- 直接给年包 → 直接用
- 用薪资范围的上下限平均值来计算
- 年薪 = {salary_baseline}K → 薪资分 = 50（基准线）
- 年薪 < {salary_baseline}K → 50 - ({salary_baseline}-年薪)/10
- 年薪 > {salary_baseline}K → 50 + (年薪-{salary_baseline})/5，不封顶
- 薪资未提及/面议 → 薪资分 = 50（按基准处理）
- 岗位类型不限，只看钱

## 对方信息
- 公司：{job_company}
- 对方角色：{job_position}（如HR/猎头/招聘经理）
- 目标岗位：{job_title}（这才是给你的岗位）
- 薪资：{job_salary}
- 工作地点：{job_city}
- 对方消息：{job_message}

## 地点计分
- 深圳 → 地点分 = 0
- 香港 → 地点分 = -40
- 广东省内深圳以外（广州/东莞/佛山等）→ 地点分 = -60
- 广东省以外 → 地点分 = -100
- 地点未提及/远程 → 地点分 = 0

## ⚠️ 优先判断：对方是否已婉拒/不匹配
先分析"对方消息"，如果对方**明确表达了拒绝意图**，直接判定 REJECT，不再计分：
- 明确表示不匹配、不合适、不符合要求、经验/能力/方向有差距
- 委婉拒绝：很遗憾、暂不考虑、岗位已招满、已找到合适人选
- 通知淘汰：未通过筛选、简历未通过、不能与您共事
- 结束对话：祝您早日找到心仪工作、祝顺利等告别语（在**已拒绝**的语境下）

⚠️ 以下情况**不是婉拒**，不可判定为 REJECT：
- 收到确认："好的收到"、"已收到简历"、"我们会评估"
- 待评估："尽快评估"、"如匹配会联系"、"稍后回复"
- 礼貌客套："感谢关注"、"谢谢"（单独出现，无拒绝上下文）
- 流程性回复："会转给相关负责人"、"先看下简历"
这些属于正常沟通，应正常计分评估。

→ 仅在**确定对方表达了拒绝意图**时输出 {"score": 0, "reason": "对方婉拒:具体原因", "action": "REJECT", "detail": "对方已明确表示不匹配/拒绝"}

## 计分规则（仅在未被婉拒时使用）
无基础分，薪资分就是起点，然后叠加：
1. **薪资分**（见上方计算规则，就是基础分）
2. **地点分**（见上方计算规则）
3. **AI/智能体/Agent 相关岗位或话题** = +${sc.ai_match}（高度匹配方向）
4. **未涉及 AI/智能体/Agent** = ${sc.ai_nomatch}（方向不匹配）
5. **猎头/HR/招聘主动联系** = +${sc.recruiter_contact}（有机会就聊）
6. **垃圾/诈骗/推销**（副业、兼职、月入X万、招商加盟、退税、刷单、理财、保险代理、微商、传销、个人所得税）= -1000
7. **黑名单行业**（博彩/P2P/资金盘/网络赌博/棋牌）= -1000
8. **信息不足**（打招呼、没提薪资、没提岗位）= ${sc.info_insufficient}
9. **知名公司**（BAT、字节、华为、美团、腾讯等）= +${sc.famous_company}
10. **上市公司** = +${sc.public_company}
11. **明确996/大小周** = ${sc.s996}
${outsourceRule}

最终 score = max(0, 各项加减之和)，不设上限
- score ≥ 70 → action = REPLY
- score < 70 → action = IGNORE

## 输出（严格JSON，不要其他文字）
{"score": 整数, "reason": "15字内理由", "action": "REPLY或IGNORE或REJECT", "detail": "计算过程或婉拒原因"}`;
}

const INTERVIEW_DETECT_PROMPT = `你是一个求职助手。分析以下HR/猎头的消息，判断是否包含面试邀请。

## 属于面试邀请
- 约定面试时间（"周三下午可以吗"、"明天有空面试吗"）
- 安排面试流程（"先安排一轮技术面"、"接下来是HR面"）
- 发送面试链接（视频面试链接、在线笔试链接）
- 邀请到公司面谈（"方便来公司聊聊吗"）
- 通知面试结果后的下一轮（"一面通过，安排二面"）

## 不属于面试邀请
- 普通寒暄、打招呼、感谢回复
- 询问工作经历、技术能力
- 介绍岗位信息、公司情况
- 索取简历、要求发简历
- 仅表达"感兴趣"但未提面试

## 对方消息
{messages}

## 输出（严格JSON，不要其他文字）
{"is_interview": true或false, "summary": "30字内概要，包含面试类型/时间/方式等关键信息（未检测到则为空字符串）"}`;

const DEFAULT_CONFIG = {
  identity: {
    name: "", current_role: "", current_company: "",
    experience_years: 5, tech_stack: [], highlights: [],
  },
  filters: {
    salary_baseline_k: 300,
    cities: ["深圳", "广州", "远程"],
    position_levels: ["架构师", "技术专家", "技术总监", "CTO"],
    blacklist_industries: ["博彩", "P2P", "资金盘", "区块链交易所", "棋牌游戏", "网络赌博"],
    accept_outsource: false,
  },
  scoring: {
    outsource: -100,
    s996: -20,
    info_insufficient: -50,
    ai_match: 10,
    ai_nomatch: -5,
    famous_company: 10,
    public_company: 5,
    recruiter_contact: 5,
  },
  actions: {
    auto_reply_threshold: 70, max_per_scan: 10,
    interview_keywords: ["面试邀请", "安排面试", "技术面", "HR面", "终面", "视频面试", "几号有空", "约个时间面试", "到公司面试"],
    greeting_template: "你好，我是{name}的 AI 助理，自动代为回复。经评估，贵司岗位意愿匹配度为 {score} 分（≥{threshold} 为有意向）。对贵司的机会很感兴趣，附上简历供参考。",
    followup_template: "您好，感谢您的关注。当前消息由我的 AI 助理自动回复，您的信息已通知到我本人，我会尽快亲自与您联系，谢谢！",
  },
  llm: {
    provider: "glm",
    api_url: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    api_key: "", model: "GLM-4.7",
  },
  openclaw: {
    enabled: false,
    gateway_url: "http://127.0.0.1:18789",
    token: "",
    notify_reply: true,
    notify_interview: true,
    notify_summary: false,
  },
};

// ── 存储 ──
// 每条处理记录用独立 key "p_<chatId>" 存储，避免 read-modify-write 竞态
const P = "p_";

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return config ? config : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}
async function saveConfigStore(cfg) {
  await chrome.storage.local.set({ config: cfg });
}
async function getAllProcessed() {
  const all = await chrome.storage.local.get(null);
  const result = {};
  for (const [key, val] of Object.entries(all)) {
    if (key.startsWith(P)) result[key.slice(P.length)] = val;
  }
  return result;
}
async function saveToProcessed(chatId, result) {
  await chrome.storage.local.set({ [P + chatId]: result });
  console.log(`[Boss助手] 已保存: ${chatId} (${result.score}分 ${result.action})`);
}
async function markCompleted(chatId) {
  const key = P + chatId;
  const data = await chrome.storage.local.get(key);
  if (data[key]) {
    data[key].completed = true;
    await chrome.storage.local.set({ [key]: data[key] });
  }
}

// ── LLM 统一调用 ──
async function llmChat(llmCfg, prompt) {
  const provider = llmCfg.provider || "glm";
  const apiUrl = llmCfg.api_url || LLM_PROVIDERS[provider]?.api_url || "";
  const apiKey = llmCfg.api_key || "";
  const model = llmCfg.model || "GLM-4.7";
  const fmt = LLM_PROVIDERS[provider]?.format || "openai";

  if (!apiKey) { console.error("[Boss助手] 未配置 API Key"); return null; }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let content;

      if (fmt === "claude") {
        const resp = await fetch(apiUrl, {
          method: "POST",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }], temperature: 0.1 }),
        });
        if (resp.status === 429) { await sleep((attempt + 1) * 5000); continue; }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rj = await resp.json();
        const blocks = rj.content || [];
        const tb = blocks.find(b => b.type === "text") || blocks[blocks.length - 1];
        content = (tb?.text || "").trim();

      } else if (fmt === "gemini") {
        const url = apiUrl.replace("{model}", model) + `?key=${apiKey}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } }),
        });
        if (resp.status === 429) { await sleep((attempt + 1) * 5000); continue; }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rj = await resp.json();
        content = rj.candidates[0].content.parts[0].text.trim();

      } else {
        const resp = await fetch(apiUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.1 }),
        });
        if (resp.status === 429) { await sleep((attempt + 1) * 5000); continue; }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const rj = await resp.json();
        if (!rj.choices) {
          throw new Error(`API 返回空结果: ${rj.base_resp?.status_msg || "unknown"}`);
        }
        content = rj.choices[0].message.content.trim();
      }

      if (content.startsWith("```")) {
        content = content.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim();
      }
      return JSON.parse(content);

    } catch (e) {
      if (attempt < 2 && String(e).includes("429")) { await sleep((attempt + 1) * 5000); continue; }
      console.error(`[Boss助手] LLM 异常 (${provider}/${model}):`, e);
      return null;
    }
  }
  return null;
}

// ── 纯规则评分引擎（无 LLM 降级模式）──
function parseSalaryK(salaryText) {
  if (!salaryText || salaryText === "未知" || salaryText === "面议") return null;
  // "40-60K·14薪" → 年薪 700K
  const m = salaryText.match(/(\d+)\s*[-~]\s*(\d+)\s*[Kk]/);
  if (!m) return null;
  const lo = parseInt(m[1]), hi = parseInt(m[2]);
  const nMatch = salaryText.match(/(\d+)\s*薪/);
  const months = nMatch ? parseInt(nMatch[1]) : 12;
  return (lo + hi) / 2 * months;
}

function ruleCityScore(city) {
  if (!city || city === "未知" || city.includes("远程")) return 0;
  if (city.includes("深圳")) return 0;
  if (city.includes("香港")) return -40;
  const gdCities = ["广州", "东莞", "佛山", "珠海", "中山", "惠州", "江门", "肇庆", "汕头", "湛江"];
  if (gdCities.some(c => city.includes(c))) return -60;
  return -100; // 广东省以外
}

const SPAM_KEYWORDS = ["副业", "兼职", "月入", "招商加盟", "退税", "刷单", "理财", "保险代理", "微商", "传销", "个人所得税", "日结", "轻松赚"];
const BLACKLIST_KEYWORDS = ["博彩", "P2P", "资金盘", "网络赌博", "棋牌", "彩票"];
const OUTSOURCE_KEYWORDS = ["外包", "外派", "驻场", "人力外包", "人力派遣"];
const S996_KEYWORDS = ["996", "大小周", "007"];
const AI_KEYWORDS = ["AI", "人工智能", "大模型", "Agent", "智能体", "LLM", "机器学习", "深度学习", "NLP", "CV", "算法", "AIGC", "GPT", "RAG"];
const RECRUITER_KEYWORDS = ["猎头", "HR", "人力资源", "招聘顾问", "HRBP", "招聘经理", "人才顾问"];
const FAMOUS_COMPANIES = ["腾讯", "阿里", "百度", "字节跳动", "华为", "美团", "京东", "网易", "小米", "滴滴", "快手", "拼多多", "蚂蚁", "微软", "谷歌", "Google", "Microsoft", "Amazon", "亚马逊", "苹果", "Apple", "Meta", "字节", "ByteDance", "Tencent", "Alibaba", "Baidu"];
const PUBLIC_COMPANY_HINTS = ["上市公司", "A股", "港股", "纳斯达克", "NYSE", "IPO"];

function ruleBasedEvaluate(config, jobInfo) {
  const fi = config.filters || {};
  const sc = config.scoring || DEFAULT_CONFIG.scoring;
  const baseline = fi.salary_baseline_k || 500;
  const acceptOut = fi.accept_outsource || false;

  const allText = [jobInfo.company, jobInfo.position, jobInfo.title, jobInfo.salary, jobInfo.city, jobInfo.message].join(" ");
  let score = 50; // 默认基准分
  const details = [];

  // 1. 薪资计分
  const annualK = parseSalaryK(jobInfo.salary);
  if (annualK !== null) {
    if (annualK >= baseline) {
      score = 50 + (annualK - baseline) / 5;
    } else {
      score = 50 - (baseline - annualK) / 10;
    }
    details.push(`薪资${annualK}K→${Math.round(score)}分`);
  } else {
    details.push("薪资未知→50分");
  }

  // 2. 地点计分
  const cityScore = ruleCityScore(jobInfo.city);
  if (cityScore !== 0) {
    score += cityScore;
    details.push(`地点${jobInfo.city}→${cityScore}`);
  }

  // 3. 垃圾/诈骗
  if (SPAM_KEYWORDS.some(kw => allText.includes(kw))) {
    score -= 1000;
    details.push("垃圾/诈骗-1000");
  }

  // 4. 黑名单行业
  const blConfig = fi.blacklist_industries || [];
  const blAll = [...BLACKLIST_KEYWORDS, ...blConfig];
  if (blAll.some(kw => allText.includes(kw))) {
    score -= 1000;
    details.push("黑名单行业-1000");
  }

  // 5. 外包/外派
  if (!acceptOut && OUTSOURCE_KEYWORDS.some(kw => allText.includes(kw))) {
    score += sc.outsource;
    details.push(`外包${sc.outsource}`);
  }

  // 6. 996/大小周
  if (S996_KEYWORDS.some(kw => allText.includes(kw))) {
    score += sc.s996;
    details.push(`996${sc.s996}`);
  }

  // 7. 信息不足（薪资和岗位都缺失）
  const noSalary = !jobInfo.salary || jobInfo.salary === "未知" || jobInfo.salary === "面议";
  const noTitle = !jobInfo.title || jobInfo.title === "未知";
  if (noSalary && noTitle) {
    score += sc.info_insufficient;
    details.push(`信息不足${sc.info_insufficient}`);
  }

  // 8. AI 方向
  const titleAndMsg = [jobInfo.title, jobInfo.message, jobInfo.position].join(" ");
  if (AI_KEYWORDS.some(kw => titleAndMsg.toUpperCase().includes(kw.toUpperCase()))) {
    score += sc.ai_match;
    details.push(`AI方向+${sc.ai_match}`);
  } else {
    score += sc.ai_nomatch;
    details.push(`非AI${sc.ai_nomatch}`);
  }

  // 9. 猎头/HR
  if (RECRUITER_KEYWORDS.some(kw => (jobInfo.position || "").includes(kw))) {
    score += sc.recruiter_contact;
    details.push(`猎头/HR+${sc.recruiter_contact}`);
  }

  // 10. 知名公司
  if (FAMOUS_COMPANIES.some(kw => (jobInfo.company || "").includes(kw))) {
    score += sc.famous_company;
    details.push(`知名公司+${sc.famous_company}`);
  }

  // 11. 上市公司
  if (PUBLIC_COMPANY_HINTS.some(kw => allText.includes(kw))) {
    score += sc.public_company;
    details.push(`上市公司+${sc.public_company}`);
  }

  score = Math.max(0, Math.round(score));
  const action = score >= (config.actions?.auto_reply_threshold || 70) ? "REPLY" : "IGNORE";
  const reason = score >= 70 ? details.slice(0, 2).join(";") : details.slice(0, 2).join(";");

  return { score, reason: reason.substring(0, 15), action, detail: `[规则引擎] ${details.join(" | ")}` };
}

// ── 评估 ──
async function llmEvaluate(config, jobInfo) {
  const id = config.identity || {};
  const fi = config.filters || {};
  const prompt = fillPrompt(buildEvalPrompt(config), {
    name: id.name || "", role: id.current_role || "", company: id.current_company || "",
    years: id.experience_years || 10, stack: (id.tech_stack || []).join(", "),
    cities: (fi.cities || []).join(", "), salary_baseline: fi.salary_baseline_k || 500,
    blacklist: (fi.blacklist_industries || []).join(", "),
    job_company: jobInfo.company || "未知", job_position: jobInfo.position || "未知",
    job_title: jobInfo.title || "未知", job_salary: jobInfo.salary || "未知",
    job_city: jobInfo.city || "未知", job_message: (jobInfo.message || "无").substring(0, 500),
  });
  return (await llmChat(config.llm || {}, prompt)) || { score: 50, reason: "评估异常", action: "ASK" };
}

// ── 面试检测 ──
function detectInterviewKw(messages, keywords) {
  for (const msg of messages) {
    for (const kw of keywords) {
      if (msg.includes(kw)) return { found: true, keyword: kw, message: msg };
    }
  }
  return { found: false };
}

// ── 婉拒/不匹配检测（省掉 LLM 调用）──
const REJECT_KEYWORDS = [
  "不太匹配", "不匹配", "不太符合", "不符合要求", "不太契合",
  "不太合适", "不合适", "不太适合",
  "很遗憾", "非常遗憾", "遗憾地通知",
  "不能与您共事", "无法与您共事",
  "祝您早日找到", "祝您找到心仪",
  "岗位已招满", "已招到合适", "已经找到合适",
  "暂不考虑", "暂时没有合适", "目前没有合适",
  "未能通过", "未通过筛选", "简历未通过",
  "与岗位要求有差距", "经验方面有些差距",
  "不太满足岗位", "达不到要求",
];
// ── 接受简历检测（跳过自动回复）──
const ACCEPT_RESUME_KEYWORDS = [
  "已接受您的简历", "接受了你的简历", "接受了您的简历",
  "简历已接受", "已查看简历", "已接收简历",
  "已接受简历", "接受简历",
];
function detectAcceptResume(messages) {
  for (const msg of messages) {
    for (const kw of ACCEPT_RESUME_KEYWORDS) {
      if (msg.includes(kw)) return { found: true, keyword: kw, message: msg };
    }
  }
  return { found: false };
}

function detectRejectKw(messages) {
  for (const msg of messages) {
    for (const kw of REJECT_KEYWORDS) {
      if (msg.includes(kw)) return { found: true, keyword: kw, message: msg };
    }
  }
  return { found: false };
}

async function llmDetectInterview(config, text) {
  const prompt = fillPrompt(INTERVIEW_DETECT_PROMPT, { messages: text });
  return (await llmChat(config.llm || {}, prompt)) || { is_interview: false, summary: "" };
}

// ── OpenClaw 通知 ──
async function notifyOpenClaw(config, event, data) {
  const oc = config.openclaw;
  if (!oc?.enabled || !oc?.token) return;
  if (event === "reply" && !oc.notify_reply) return;
  if (event === "interview" && !oc.notify_interview) return;
  if (event === "summary" && !oc.notify_summary) return;

  let text = "";
  if (event === "reply") {
    text = `[Boss助手] 已自动投递\n公司: ${data.company}\n岗位: ${data.jobTitle || data.position}\n薪资: ${data.salary || "未知"}\n评分: ${data.score}分\n理由: ${data.reason}`;
  } else if (event === "interview") {
    text = `[Boss助手] 检测到面试邀请\n公司: ${data.company}\n岗位: ${data.jobTitle || data.position}\n关键词: ${data.keyword}\n内容: ${(data.message || "").substring(0, 100)}`;
  } else if (event === "summary") {
    text = `[Boss助手] 第${data.round}轮扫描完成\n评估: ${data.evaluated} | 投递: ${data.replied} | 跳过: ${data.skipped}\n累计已处理: ${data.total}`;
  }
  if (!text) return;

  const url = (oc.gateway_url || "http://127.0.0.1:18789").replace(/\/+$/, "");
  try {
    const resp = await fetch(`${url}/v1/notify`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${oc.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, source: "boss-jobseeker", event }),
    });
    if (!resp.ok) console.warn(`[Boss助手] OpenClaw 通知响应: ${resp.status}`);
    else console.log(`[Boss助手] OpenClaw 通知已发送: ${event}`);
  } catch (e) {
    console.error("[Boss助手] OpenClaw 通知失败:", e);
  }
}

// ── 消息路由 ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    health: () => getConfig().then(c => ({ status: "ok", configured: true, hasLlm: !!c.llm?.api_key })),
    evaluate: () => handleEvaluate(msg.data),
    detectInterview: () => handleDetectInterview(msg.data),
    notifySent: () => handleNotifySent(msg.data),
    getProcessed: () => handleGetProcessed(),
    getConfig: () => handleGetConfig(),
    saveConfig: () => handleSaveConfig(msg.data),
    getStats: () => handleGetStats(),
    clearProcessed: () => handleClearProcessed(),
    notifyRoundSummary: () => handleNotifyRoundSummary(msg.data),
  };
  const handler = handlers[msg.action];
  if (handler) { handler().then(sendResponse); return true; }
});

async function handleEvaluate(data) {
  const config = await getConfig();
  const { chatId = "", company = "", position = "", salary = "" } = data;
  const messages = data.messages || [];
  const actionsCfg = config.actions || {};
  const kws = actionsCfg.interview_keywords || DEFAULT_CONFIG.actions.interview_keywords;
  const threshold = actionsCfg.auto_reply_threshold || 70;
  const greetTpl = actionsCfg.greeting_template || DEFAULT_CONFIG.actions.greeting_template;
  const ident = config.identity || {};

  // 关键词面试检测 → 直接标记，不发招呼/简历
  const inv = detectInterviewKw(messages, kws);
  if (inv.found) {
    const r = {
      type: "INTERVIEW", chatId, company, position,
      jobTitle: data.jobTitle || "", salary, city: data.city || "",
      keyword: inv.keyword, message: inv.message.substring(0, 200),
      score: 100, reason: `面试邀请[${inv.keyword}]`, action: "INTERVIEW",
      greeting: null,
      debug: data.debug || false, completed: true, timestamp: ts(),
    };
    await saveToProcessed(chatId, r);
    notifyOpenClaw(config, "interview", r);
    console.log(`[Boss助手] INTERVIEW(跳过自动回复): ${company} | ${inv.keyword}`);
    return r;
  }

  // 婉拒/不匹配检测 → 直接跳过，不调 LLM
  const rej = detectRejectKw(messages);
  if (rej.found) {
    const r = {
      type: "REJECT", chatId, company, position,
      jobTitle: data.jobTitle || "", salary, city: data.city || "",
      keyword: rej.keyword, message: rej.message.substring(0, 200),
      score: 0, reason: `对方婉拒[${rej.keyword}]`, action: "REJECT",
      greeting: null,
      debug: data.debug || false, completed: true, timestamp: ts(),
    };
    await saveToProcessed(chatId, r);
    console.log(`[Boss助手] REJECT(跳过): ${company} | ${rej.keyword}`);
    return r;
  }

  // 对方接受简历 → 跳过自动回复，仅记录
  const accept = detectAcceptResume(messages);
  if (accept.found) {
    const r = {
      type: "ACCEPTED", chatId, company, position,
      jobTitle: data.jobTitle || "", salary, city: data.city || "",
      keyword: accept.keyword, message: accept.message.substring(0, 200),
      score: 60, reason: `对方接受简历`, action: "IGNORE",
      greeting: null,
      debug: data.debug || false, completed: true, timestamp: ts(),
    };
    await saveToProcessed(chatId, r);
    console.log(`[Boss助手] ACCEPTED(跳过自动回复): ${company} | ${accept.keyword}`);
    return r;
  }

  // 岗位评分：有 API Key → LLM，无 → 规则引擎
  const jobInfo = { company, position, title: data.jobTitle || "", salary, city: data.city || "", message: messages.slice(-5).join("\n") };
  const ev = config.llm?.api_key
    ? await llmEvaluate(config, jobInfo)
    : ruleBasedEvaluate(config, jobInfo);
  const { score = 0, reason = "", action = "IGNORE", detail = "" } = ev;

  let greeting = null;
  if (action === "REPLY" && score >= threshold) {
    greeting = fillPrompt(greetTpl.trim(), { score, name: ident.name || "", role: ident.current_role || "", company: ident.current_company || "", threshold });
  }

  const r = {
    type: action, chatId, company, position,
    jobTitle: data.jobTitle || "", salary, city: data.city || "",
    score, reason, detail, action, greeting,
    debug: data.debug || false, completed: action !== "REPLY", timestamp: ts(),
  };
  await saveToProcessed(chatId, r);
  if (action === "REPLY" && score >= threshold) notifyOpenClaw(config, "reply", r);
  console.log(`[Boss助手] ${score}分 | ${action} | ${company} | ${salary} | ${reason}`);
  return r;
}

async function handleDetectInterview(data) {
  const config = await getConfig();
  const messages = (data.messages || []).slice(-10);
  const text = messages.join("\n");

  // 无 LLM 时仅用关键词检测
  if (!config.llm?.api_key) {
    const kws = config.actions?.interview_keywords || DEFAULT_CONFIG.actions.interview_keywords;
    const inv = detectInterviewKw(messages, kws);
    if (inv.found) {
      console.log(`[Boss助手] 面试邀请(规则): ${data.company} | ${inv.keyword}`);
      return { is_interview: true, summary: `关键词匹配: ${inv.keyword}` };
    }
    return { is_interview: false, summary: "" };
  }

  const r = await llmDetectInterview(config, text);
  if (r.is_interview) console.log(`[Boss助手] 面试邀请: ${data.company} | ${r.summary}`);
  return r;
}

async function handleNotifySent(data) {
  if (data.chatId) await markCompleted(data.chatId);
  console.log(`[Boss助手] 已投递: ${data.company}`);
  return { ok: true };
}

async function handleGetProcessed() {
  const p = await getAllProcessed();
  const completed = [], pending = [];
  for (const [cid, entry] of Object.entries(p)) {
    const done = entry.completed !== undefined ? entry.completed : (entry.action || entry.type) !== "REPLY";
    (done ? completed : pending).push(done ? cid : entry);
  }
  return { completed, pending };
}

async function handleGetConfig() {
  const c = await getConfig();
  return {
    identity: { name: c.identity?.name || "", current_role: c.identity?.current_role || "", current_company: c.identity?.current_company || "", experience_years: c.identity?.experience_years || 10, tech_stack: c.identity?.tech_stack || [] },
    filters: { salary_baseline_k: c.filters?.salary_baseline_k || 500, cities: c.filters?.cities || [], blacklist_industries: c.filters?.blacklist_industries || [], accept_outsource: c.filters?.accept_outsource || false },
    scoring: {
      outsource: c.scoring?.outsource ?? -100,
      s996: c.scoring?.s996 ?? -20,
      info_insufficient: c.scoring?.info_insufficient ?? -50,
      ai_match: c.scoring?.ai_match ?? 10,
      ai_nomatch: c.scoring?.ai_nomatch ?? -5,
      famous_company: c.scoring?.famous_company ?? 10,
      public_company: c.scoring?.public_company ?? 5,
      recruiter_contact: c.scoring?.recruiter_contact ?? 5,
    },
    actions: { auto_reply_threshold: c.actions?.auto_reply_threshold || 70, greeting_template: c.actions?.greeting_template || "", followup_template: c.actions?.followup_template || "", max_per_scan: c.actions?.max_per_scan || 10 },
    llm: { provider: c.llm?.provider || "glm", api_url: c.llm?.api_url || "", api_key: c.llm?.api_key || "", model: c.llm?.model || "" },
    openclaw: {
      enabled: c.openclaw?.enabled || false,
      gateway_url: c.openclaw?.gateway_url || "http://127.0.0.1:18789",
      token: c.openclaw?.token || "",
      notify_reply: c.openclaw?.notify_reply !== false,
      notify_interview: c.openclaw?.notify_interview !== false,
      notify_summary: c.openclaw?.notify_summary || false,
    },
    providers: LLM_PROVIDERS,
  };
}

async function handleSaveConfig(data) {
  const c = await getConfig();
  if (data.identity) {
    c.identity = c.identity || {};
    for (const k of ["name", "current_role", "current_company"]) { if (data.identity[k] !== undefined) c.identity[k] = data.identity[k]; }
    if (data.identity.experience_years !== undefined) c.identity.experience_years = parseInt(data.identity.experience_years) || 10;
    if (data.identity.tech_stack !== undefined) c.identity.tech_stack = data.identity.tech_stack;
  }
  if (data.filters) {
    c.filters = c.filters || {};
    if (data.filters.salary_baseline_k !== undefined) c.filters.salary_baseline_k = parseInt(data.filters.salary_baseline_k) || 500;
    if (data.filters.cities !== undefined) c.filters.cities = data.filters.cities;
    if (data.filters.blacklist_industries !== undefined) c.filters.blacklist_industries = data.filters.blacklist_industries;
    if (data.filters.accept_outsource !== undefined) c.filters.accept_outsource = data.filters.accept_outsource;
  }
  if (data.scoring) {
    c.scoring = c.scoring || {};
    for (const k of ["outsource", "s996", "info_insufficient", "ai_match", "ai_nomatch", "famous_company", "public_company", "recruiter_contact"]) {
      if (data.scoring[k] !== undefined) c.scoring[k] = parseInt(data.scoring[k]);
    }
  }
  if (data.actions) {
    c.actions = c.actions || {};
    if (data.actions.auto_reply_threshold !== undefined) c.actions.auto_reply_threshold = parseInt(data.actions.auto_reply_threshold) || 70;
    if (data.actions.max_per_scan !== undefined) c.actions.max_per_scan = parseInt(data.actions.max_per_scan) || 10;
    for (const k of ["greeting_template", "followup_template"]) { if (data.actions[k] !== undefined) c.actions[k] = data.actions[k]; }
  }
  if (data.llm) {
    c.llm = c.llm || {};
    for (const k of ["provider", "api_url", "api_key", "model"]) { if (data.llm[k] !== undefined) c.llm[k] = data.llm[k]; }
  }
  if (data.openclaw) {
    c.openclaw = c.openclaw || {};
    if (data.openclaw.enabled !== undefined) c.openclaw.enabled = data.openclaw.enabled;
    for (const k of ["gateway_url", "token"]) { if (data.openclaw[k] !== undefined) c.openclaw[k] = data.openclaw[k]; }
    for (const k of ["notify_reply", "notify_interview", "notify_summary"]) { if (data.openclaw[k] !== undefined) c.openclaw[k] = data.openclaw[k]; }
  }
  await saveConfigStore(c);
  console.log("[Boss助手] 配置已保存");
  return { ok: true };
}

async function handleGetStats() {
  const p = await getAllProcessed();
  const keys = Object.keys(p);
  const entries = Object.values(p);
  const stats = {};
  for (const v of entries) { const t = v.type || "IGNORE"; stats[t] = (stats[t] || 0) + 1; }
  const recent_all = entries.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")).slice(0, 20);
  console.log(`[Boss助手] getStats: 共 ${keys.length} 条, keys样例: ${keys.slice(0, 5).join(", ")}`);
  return { total: keys.length, stats, recent_all };
}

async function handleNotifyRoundSummary(data) {
  const config = await getConfig();
  await notifyOpenClaw(config, "summary", data || {});
  return { ok: true };
}

async function handleClearProcessed() {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(k => k.startsWith(P));
  if (keysToRemove.length > 0) await chrome.storage.local.remove(keysToRemove);
  console.log(`[Boss助手] 已清除 ${keysToRemove.length} 条处理记录`);
  return { ok: true, cleared: keysToRemove.length };
}

// ── 初始化 ──
chrome.runtime.onInstalled.addListener(async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) {
    await chrome.storage.local.set({ config: DEFAULT_CONFIG });
    console.log("[Boss助手] 已初始化默认配置");
  }
  // 迁移：旧版 "processed" 单一对象 → 每条独立 key "p_xxx"
  const { processed } = await chrome.storage.local.get("processed");
  if (processed && typeof processed === "object") {
    const batch = {};
    for (const [chatId, entry] of Object.entries(processed)) {
      batch[P + chatId] = entry;
    }
    if (Object.keys(batch).length > 0) {
      await chrome.storage.local.set(batch);
      console.log(`[Boss助手] 已迁移 ${Object.keys(batch).length} 条旧记录`);
    }
    await chrome.storage.local.remove("processed");
  }
});
