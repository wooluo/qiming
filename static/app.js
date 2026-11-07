"use strict";
/* 启名 · AI 起名 前端（原生 JS，零依赖）
 * 架构与六爻金钱卦一致：连本机服务 → 流式；无服务/安卓 → 离线直连 AI。
 * 八字排盘（bazi.js）与三才五格（data/wuge.js）均为程序本地计算，AI 只负责生成候选。 */

// ---------------- 基础工具 ----------------
const app = document.getElementById("app");
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

async function api(path, opts = {}) {
  if (MODE === "client") return clientApi(path, opts);
  const init = { method: opts.method || "GET", headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null || typeof data !== "object") {
    throw new Error((data && data.error) || "HTTP " + res.status);
  }
  return data;
}

// ---------------- 服务器探测 / 离线（App）模式 ----------------
let MODE = "server"; // server = 走本地 Python 服务；client = 离线（APK / 直接打开页面）

function lsGet(k, d) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
}
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

function defaultConfig() {
  return {
    provider: "glm",
    providers: {
      glm: { label: "GLM 智谱（Coding Plan）", protocol: "openai", base: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3", api_key: "", fast: true }
    }
  };
}

function clientRawConfig() {
  const stored = lsGet("qiming.config", null);
  if (!stored) return defaultConfig();
  const base = defaultConfig();
  Object.keys(base.providers).forEach((pid) => {
    if (!stored.providers || !stored.providers[pid]) {
      stored.providers = stored.providers || {};
      stored.providers[pid] = base.providers[pid];
    }
  });
  if (!stored.providers[stored.provider]) stored.provider = base.provider;
  return stored;
}

function applyConfigPatch(cfg, body) {
  if (body.provider && cfg.providers[body.provider]) cfg.provider = body.provider;
  Object.entries(body.providers || {}).forEach(([pid, p]) => {
    if (!p || typeof p !== "object" || !cfg.providers[pid]) return;
    const tgt = cfg.providers[pid];
    ["label", "protocol", "base", "model"].forEach((k) => {
      if (typeof p[k] === "string") tgt[k] = p[k].trim();
    });
    if (p.protocol !== "openai" && p.protocol !== "anthropic") tgt.protocol = "openai";
    if (typeof p.api_key === "string" && p.api_key.trim()) tgt.api_key = p.api_key.trim();
    if (typeof p.fast === "boolean") tgt.fast = p.fast;
  });
}

async function detectMode() {
  // 安卓/原生环境：必定离线模式（App 内置排盘与直连能力，不依赖本机服务）
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) { MODE = "client"; return; }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch("/api/config", { signal: ctl.signal });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.indexOf("json") >= 0) {
      const data = await res.json().catch(() => null);
      if (data && data.providers) { MODE = "server"; return; }
    }
  } catch (e) { /* 无服务器 */ }
  MODE = "client";
}

function makeId() {
  const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    + "-" + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function fmtNow() {
  const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---- 原生 HTTP（Capacitor 内绕过 CORS；浏览器则退回 fetch） ----
function nativeHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.CapacitorHttp && (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.CapacitorHttp;
  }
  return null;
}

async function httpJSON(method, url, headers, bodyObj, timeoutMs) {
  const nh = nativeHttp();
  if (nh) {
    const r = await nh.request({ method, url, headers: headers || {}, data: bodyObj });
    if (r.status >= 400) {
      throw new Error("HTTP " + r.status + "：" + JSON.stringify(r.data).slice(0, 200));
    }
    return { status: r.status, json: r.data };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method, headers,
      body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
      signal: ctl.signal
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = j && j.error ? (j.error.message || j.error) : JSON.stringify(j).slice(0, 200);
      throw new Error("HTTP " + res.status + "：" + (msg || ""));
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } finally { clearTimeout(t); }
}

async function fetchModelsDirect(pcfg) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  if (!base) return [];
  const url = base + (pcfg.protocol === "anthropic" ? "/v1/models" : "/models");
  const headers = {};
  if (pcfg.api_key) { headers.Authorization = "Bearer " + pcfg.api_key; headers["x-api-key"] = pcfg.api_key; }
  const { json } = await httpJSON("GET", url, headers, undefined, 10000);
  return (json.data || []).map((m) => m && m.id).filter(Boolean);
}

const NON_CHAT_MODEL = /embed|rerank|ocr|whisper|speech|tts|stt|audio|clip/i;

async function clientApi(path, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body || {};
  if (path === "/api/config" && method === "GET") {
    const cfg = JSON.parse(JSON.stringify(clientRawConfig()));
    Object.values(cfg.providers).forEach((p) => { p.has_key = !!p.api_key; p.api_key = ""; });
    return cfg;
  }
  if (path === "/api/config" && method === "POST") {
    const cfg = clientRawConfig();
    applyConfigPatch(cfg, body);
    lsSet("qiming.config", cfg);
    return { ok: true };
  }
  if (path === "/api/favorites" && method === "GET") {
    return { favorites: lsGet("qiming.favorites", []) };
  }
  if (path === "/api/favorites" && method === "POST") {
    const list = lsGet("qiming.favorites", []);
    const it = body.item || {};
    if (it.mode !== "baby" && it.mode !== "company") throw new Error("收藏数据不合法");
    if (list.some((x) => x.name === it.name && x.mode === it.mode)) throw new Error("该名字已在收藏夹中");
    const item = Object.assign({}, it, { id: makeId(), created: fmtNow() });
    list.unshift(item);
    lsSet("qiming.favorites", list);
    return { favorite: item };
  }
  const m = path.match(/^\/api\/favorites\/([\w-]+)$/);
  if (m && method === "DELETE") {
    lsSet("qiming.favorites", lsGet("qiming.favorites", []).filter((x) => x.id !== m[1]));
    return { ok: true };
  }
  if (path.startsWith("/api/models")) {
    const pid = new URLSearchParams(path.split("?")[1] || "").get("provider") || "";
    const pcfg = clientRawConfig().providers[pid];
    if (!pcfg) throw new Error("未知 provider");
    return { models: await fetchModelsDirect(pcfg) };
  }
  throw new Error("离线模式不支持：" + path);
}

// ---- 离线直连生成 ----
function nativeStreamHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.StreamHttp &&
      (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.StreamHttp;
  }
  return null;
}

async function resolveClientModel(pcfg) {
  let model = (pcfg.model || "").trim();
  if (!model) {
    try {
      const ms = await fetchModelsDirect(pcfg);
      model = ms.find((x) => !NON_CHAT_MODEL.test(x)) || ms[0] || "";
    } catch (e) { /* 留空报错 */ }
  }
  return model;
}

function clientRequestBody(pcfg, model, system, user, stream) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  let url, headers, payload;
  if (pcfg.protocol === "anthropic") {
    url = base + "/v1/messages";
    headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (pcfg.api_key) { headers["x-api-key"] = pcfg.api_key; headers.Authorization = "Bearer " + pcfg.api_key; }
    payload = { model, max_tokens: 8192, temperature: 0.8, stream: !!stream, system,
                messages: [{ role: "user", content: user }] };
  } else {
    url = base + "/chat/completions";
    headers = { "Content-Type": "application/json" };
    if (pcfg.api_key) headers.Authorization = "Bearer " + pcfg.api_key;
    payload = { model, temperature: 0.8, stream: !!stream,
                messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  }
  // 快速模式：智谱系端点关闭深度思考，显著缩短等待
  if (pcfg.fast && /bigmodel|z\.ai/i.test(pcfg.base || "")) {
    payload.thinking = { type: "disabled" };
  }
  return { url, headers, payload };
}

// 非流式（浏览器离线模式）
async function clientGenerate(pid, system, user) {
  const pcfg = clientRawConfig().providers[pid];
  if (!pcfg) throw new Error("未知 provider：" + pid);
  const model = await resolveClientModel(pcfg);
  if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
  const req = clientRequestBody(pcfg, model, system, user, false);
  const { json } = await httpJSON("POST", req.url, req.headers, req.payload, 300000);
  let text = "";
  if (json && Array.isArray(json.choices) && json.choices[0]) {
    text = (json.choices[0].message || {}).content || "";
  } else if (json && Array.isArray(json.content)) {
    text = json.content.map((b) => (b && b.text) || "").join("");
  }
  if (!text) throw new Error("模型未返回内容：" + JSON.stringify(json).slice(0, 160));
  return text;
}

// 流式（原生 StreamHttp 插件）：SSE 增量逐段回调 onDelta
let nativeStreamCancel = null;

function clientGenerateStream(pid, system, user, onDelta) {
  return new Promise((resolve, reject) => {
    (async () => {
      const plugin = nativeStreamHttp();
      const pcfg = clientRawConfig().providers[pid];
      if (!pcfg) { reject(new Error("未知 provider：" + pid)); return; }
      const model = await resolveClientModel(pcfg);
      if (!model) { reject(new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。")); return; }
      const req = clientRequestBody(pcfg, model, system, user, true);
      const id = "g" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      let acc = "", reason = "", finished = false;
      const handles = [];
      const cleanup = () => { handles.forEach((h) => { try { h.remove && h.remove(); } catch (e) {} }); };
      const finish = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        nativeStreamCancel = null;
        if (err) reject(err);
        else if (!acc) reject(new Error("模型未返回内容"));
        else resolve(acc);
      };
      nativeStreamCancel = () => { try { plugin.cancel({ id }); } catch (e) {} };
      try {
        handles.push(await plugin.addListener("stream-http-data", (e) => {
          if (e.id !== id || !e.payload || e.payload === "[DONE]") return;
          let obj;
          try { obj = JSON.parse(e.payload); } catch (err) { return; }
          let t = "", r = "";
          if (obj.choices && obj.choices[0]) {
            const d = (obj.choices[0].delta) || {};
            t = d.content || "";
            r = d.reasoning_content || d.reasoning || "";
          } else if (obj.type === "content_block_delta") {
            t = (obj.delta || {}).text || "";
          } else if (obj.type === "thinking_delta") {
            r = (obj.delta || {}).thinking || "";
          }
          if (t || r) {
            if (t) acc += t;
            if (r) reason += r;
            onDelta({ content: acc, reason });
          }
        }));
        handles.push(await plugin.addListener("stream-http-end", (e) => { if (e.id === id) finish(); }));
        handles.push(await plugin.addListener("stream-http-error", (e) => {
          if (e.id === id) finish(new Error(e.message || "上游错误"));
        }));
        await plugin.request({ id, url: req.url, headers: req.headers, body: JSON.stringify(req.payload) });
      } catch (e) { finish(e); }
    })();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("已复制到剪贴板");
  }
}

// ---------------- 极简 Markdown（降级展示原文用） ----------------
function md(src) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [], list = null;
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  const flushL = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flushP(); flushL(); continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flushP(); flushL();
      const lv = Math.min(m[1].length + 1, 4);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
    } else if ((m = l.match(/^[-•]\s+(.*)$/))) {
      flushP();
      if (list !== "ul") { flushL(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(m[1]) + "</li>");
    } else {
      flushL(); para.push(l);
    }
  }
  flushP(); flushL();
  return out.join("\n");
}

// ---------------- 配置缓存 ----------------
let config = null;
async function loadConfig(force) {
  if (config && !force) return config;
  try { config = await api("/api/config"); } catch (e) { config = null; }
  return config;
}

// ---------------- 评分与数据加工 ----------------
const LUCK_SCORE = { "大吉": 100, "吉": 85, "半吉": 65, "凶": 40, "大凶": 15 };

// 对齐逐字五行：wuxing 数组与姓名等长则对位，否则尽量截取名部分
function alignWuxing(it, surLen) {
  const chars = it.name.split("");
  const wx = (it.wuxing || []).filter((x) => x);  // null 已滤但保留位置
  if (wx.length === chars.length) return chars.map((c, i) => ({ ch: c, e: it.wuxing[i] || null }));
  if (wx.length === chars.length - surLen) {
    return chars.map((c, i) => ({ ch: c, e: i < surLen ? null : it.wuxing[i - surLen] || null }));
  }
  return chars.map((c) => ({ ch: c, e: null }));
}

// 五行匹配分：名字用字命中宜补五行的比例（0-100）
function wxMatchScore(wxChars, surLen, bu) {
  if (!bu || !bu.length) return 70;
  const given = wxChars.slice(surLen);
  const known = given.filter((x) => x.e);
  if (!known.length) return 70;
  const hit = known.filter((x) => bu.indexOf(x.e) >= 0).length;
  return Math.round(55 + 45 * (hit / known.length));
}

/* 综合评分（页面明示权重）：
 * - 宝宝（含八字）：五行匹配40% + 三才五格30% + 音律15% + 字义出处15%
 * - 宝宝（未填生辰）：三才五格50% + 音律25% + 字义出处25%
 * - 公司：数理总格40% + 音律30% + 寓意30%
 * 音律/字义为 AI 自评分；五行与五格为程序计算。缺项时按剩余权重归一化。 */
function enrichItem(it, ctx) {
  const chars = it.name.split("");
  const aiStrokes = {};
  if (Array.isArray(it.kangxi) && it.kangxi.length === chars.length) {
    chars.forEach((c, i) => { if (it.kangxi[i]) aiStrokes[c] = it.kangxi[i]; });
  }
  const wg = QiMingWuge.analyze(it.name, { surLen: ctx.surLen, aiStrokes });
  it.wuge = wg;
  it.wxChars = alignWuxing(it, ctx.surLen);
  const sound = typeof it.score_sound === "number" ? it.score_sound : 75;
  const meaning = typeof it.score_meaning === "number" ? it.score_meaning : 75;

  let parts = [];   // {name, weight, score}
  if (ctx.mode === "company") {
    const num = wg ? LUCK_SCORE[wg.grids.zong.luck] : null;
    if (num !== null) parts.push({ name: "数理总格", weight: 0.4, score: num });
    parts.push({ name: "音律", weight: 0.3, score: sound });
    parts.push({ name: "寓意", weight: 0.3, score: meaning });
    it.formula = "数理总格40% + 音律30% + 寓意30%";
  } else if (ctx.bu && ctx.bu.length) {
    const wx = wxMatchScore(it.wxChars, ctx.surLen, ctx.bu);
    parts.push({ name: "五行匹配", weight: 0.4, score: wx });
    if (wg) parts.push({ name: "三才五格", weight: 0.3, score: wg.score });
    parts.push({ name: "音律", weight: 0.15, score: sound });
    parts.push({ name: "字义出处", weight: 0.15, score: meaning });
    it.formula = "五行匹配40% + 三才五格30% + 音律15% + 字义出处15%";
    it.wxMatch = wx;
  } else {
    if (wg) parts.push({ name: "三才五格", weight: 0.5, score: wg.score });
    parts.push({ name: "音律", weight: 0.25, score: sound });
    parts.push({ name: "字义出处", weight: 0.25, score: meaning });
    it.formula = "三才五格50% + 音律25% + 字义出处25%（未填生辰，无五行项）";
  }
  const wsum = parts.reduce((a, p) => a + p.weight, 0);
  it.total = Math.round(parts.reduce((a, p) => a + p.score * (p.weight / wsum), 0));
  it.parts = parts;
  return it;
}

// ---------------- 路由 ----------------
window.addEventListener("hashchange", route);

function route() {
  const h = location.hash || "#/baby";
  const m = h.match(/^#\/([a-z]+)(?:\/([\w-]+))?/);
  const page = m ? m[1] : "baby";
  $$(".topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  window.scrollTo(0, 0);
  if (page === "company") return renderCompany();
  if (page === "score") return renderScore();
  if (page === "favorites") return renderFavorites();
  if (page === "settings") return renderSettings();
  return renderBaby();
}

// ---------------- 宝宝起名 ----------------
const BABY_STYLES = ["文雅", "大气", "诗意", "简洁"];
let babyForm = { surname: "", gender: "男", date: "", hour: "", len: "double", styles: [], avoid: "" };
let gen = { mode: null, items: [], exclude: [], ctx: null, running: false };

function computeBazi() {
  if (!babyForm.date) return null;
  const [y, m, d] = babyForm.date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const hour = babyForm.hour === "" ? null : parseInt(babyForm.hour, 10);
  try {
    const chart = LiuYaoBazi.buildChart({
      name: babyForm.surname.trim() || "命主", gender: babyForm.gender === "女" ? "女" : "男",
      y, m, d, hour
    });
    return { chart, xiyong: QiMingXiyong.analyze(chart) };
  } catch (e) { return null; }
}

function baziPanelHtml(bz) {
  if (!bz) return `
    <div class="hint" id="bz-live">
      不填出生日期则跳过八字，按<b>字义与音律</b>起名；填写后可结合五行喜忌起名（排盘由程序完成，AI 只负责起名）。
    </div>`;
  const x = bz.xiyong;
  const ELEMS = ["木", "火", "土", "金", "水"];
  const max = Math.max(1, ...ELEMS.map((e) => x.counts[e]));
  const bars = ELEMS.map((e) => {
    const n = x.counts[e];
    const weak = n === 0 || (x.bu.indexOf(e) >= 0);
    return `<div class="wx-bar ${weak ? "weak" : ""}">
      <span class="e e-${esc(e)}">${esc(e)}</span>
      <span class="track"><span class="fill f-${esc(e)}" style="width:${Math.round(n / max * 100)}%"></span></span>
      <span class="n">${n}</span>
    </div>`;
  }).join("");
  const pills = bz.chart.pillars;
  const sizhu = ["year", "month", "day", "hour"].map((k) => (pills[k] ? pills[k].gz : "时辰不详")).join("　");
  return `
    <div class="chip-row" style="margin-top:6px">
      <span class="tag meta">四柱：${esc(sizhu)}</span>
    </div>
    <div class="wx-bars">${bars}</div>
    <div class="bu-box">
      宜补五行：<b>${esc(x.bu.join("、"))}</b>（${esc(x.strength)}，${esc(x.deling ? "得令" : "不得令")}）<br>
      <span style="font-size:12.5px;color:var(--ink-soft)">${esc(x.reason)}</span>
    </div>
    <div class="rule-note">${esc(QiMingXiyong.RULE_TEXT)}</div>`;
}

async function renderBaby() {
  await loadConfig();
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>宝宝起名 <span class="sub">八字五行（程序排盘）+ 诗词典籍出处（AI）+ 三才五格（程序复核）</span></h2>
      <div class="grid2">
        <div>
          <label class="field">姓氏（必填）</label>
          <input type="text" id="f-surname" maxlength="2" placeholder="如：李 / 欧阳">
        </div>
        <div>
          <label class="field">性别</label>
          <select id="f-gender">
            <option value="男">男</option><option value="女">女</option><option value="中性">中性（不限倾向）</option>
          </select>
        </div>
      </div>
      <div class="grid2">
        <div>
          <label class="field">出生日期（选填）</label>
          <input type="date" id="f-date">
        </div>
        <div>
          <label class="field">出生时辰（选填）</label>
          <select id="f-hour">
            <option value="">不知道 / 不填</option>
            ${LiuYaoBazi.HOUR_NAMES.map((n, i) => {
              const h = i === 0 ? 0 : 2 * i - 1;  // 时辰序号 → 该时辰的代表小时（子时取早子 0 点）
              return `<option value="${h}">${n}</option>`;
            }).join("")}
          </select>
        </div>
      </div>
      <label class="field">字数偏好</label>
      <div class="mode-row tri">
        <span class="chip" data-len="single">单名（一字）</span>
        <span class="chip" data-len="double">双名（两字）</span>
        <span class="chip" data-len="any">不限</span>
      </div>
      <label class="field">期望气质（可多选）</label>
      <div class="chips" id="f-styles">
        ${BABY_STYLES.map((s) => `<span class="chip" data-style="${esc(s)}">${esc(s)}</span>`).join("")}
      </div>
      <label class="field">避讳字（选填：长辈名用字等不可用字，逗号分隔）</label>
      <input type="text" id="f-avoid" placeholder="例：伟，芳，菊">
      <div id="bz-panel"></div>
      <div class="btn-row">
        <button class="btn primary big" id="go-gen">生成 10 个候选名 →</button>
      </div>
    </div>
    <div class="card" id="gen-card" hidden></div>
    <div id="results"></div>
  </section>`;

  const bind = (id, key, ev = "input") => {
    const el = $(id);
    el.value = babyForm[key];
    el.addEventListener(ev, () => {
      babyForm[key] = el.value;
      if (key === "date" || key === "hour") paintBazi();
    });
  };
  bind("#f-surname", "surname");
  bind("#f-gender", "gender", "change");
  bind("#f-date", "date", "change");
  bind("#f-hour", "hour", "change");
  bind("#f-avoid", "avoid");
  $("#f-gender").value = babyForm.gender;
  $$("[data-len]").forEach((c) => {
    c.classList.toggle("active", c.dataset.len === babyForm.len);
    c.addEventListener("click", () => {
      babyForm.len = c.dataset.len;
      $$("[data-len]").forEach((x) => x.classList.toggle("active", x.dataset.len === babyForm.len));
    });
  });
  $$("#f-styles .chip").forEach((c) => {
    c.classList.toggle("active", babyForm.styles.indexOf(c.dataset.style) >= 0);
    c.addEventListener("click", () => {
      const i = babyForm.styles.indexOf(c.dataset.style);
      if (i >= 0) babyForm.styles.splice(i, 1); else babyForm.styles.push(c.dataset.style);
      c.classList.toggle("active", babyForm.styles.indexOf(c.dataset.style) >= 0);
    });
  });
  paintBazi();
  $("#go-gen").addEventListener("click", () => startGenerate("baby"));
  if (gen.mode === "baby" && gen.items.length) renderResults();
  else if (gen.mode === "baby" && gen.ctx) renderGenPanel();

  function paintBazi() {
    $("#bz-panel").innerHTML = baziPanelHtml(computeBazi());
  }
}

// ---------------- 公司起名 ----------------
const INDUSTRIES = ["科技/互联网", "餐饮/食品", "教育培训", "商贸/零售", "文化传媒", "医疗健康", "金融/投资", "制造/实业", "生活服务", "其他"];
const CO_STYLES = ["大气", "文雅", "现代", "传统"];
let coForm = { brand: "", industry: INDUSTRIES[0], len: "two", styles: [] };

async function renderCompany() {
  await loadConfig();
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>公司起名 <span class="sub">行业意象 + 典籍吉祥语（AI）+ 总格数理（程序复核）</span></h2>
      <label class="field">品牌词 / 创始人姓氏（选填，可自然融入名称）</label>
      <input type="text" id="c-brand" maxlength="8" placeholder="例：沈 / 云帆">
      <div class="grid2">
        <div>
          <label class="field">所属行业</label>
          <select id="c-industry">${INDUSTRIES.map((i) => `<option>${esc(i)}</option>`).join("")}</select>
        </div>
        <div>
          <label class="field">字数偏好</label>
          <select id="c-len">
            <option value="two">二字</option><option value="three">三字</option><option value="any">不限</option>
          </select>
        </div>
      </div>
      <label class="field">风格偏好（可多选）</label>
      <div class="chips" id="c-styles">
        ${CO_STYLES.map((s) => `<span class="chip" data-style="${esc(s)}">${esc(s)}</span>`).join("")}
      </div>
      <div class="hint">结果仅供参考，注册前请自行到<b>工商核名系统</b>查重。</div>
      <div class="btn-row">
        <button class="btn primary big" id="go-co-gen">生成 10 个候选名 →</button>
      </div>
    </div>
    <div class="card" id="gen-card" hidden></div>
    <div id="results"></div>
  </section>`;

  const bind = (id, key, ev = "input") => {
    const el = $(id);
    el.value = coForm[key];
    el.addEventListener(ev, () => { coForm[key] = el.value; });
  };
  bind("#c-brand", "brand");
  bind("#c-industry", "industry", "change");
  bind("#c-len", "len", "change");
  $$("#c-styles .chip").forEach((c) => {
    c.classList.toggle("active", coForm.styles.indexOf(c.dataset.style) >= 0);
    c.addEventListener("click", () => {
      const i = coForm.styles.indexOf(c.dataset.style);
      if (i >= 0) coForm.styles.splice(i, 1); else coForm.styles.push(c.dataset.style);
      c.classList.toggle("active", coForm.styles.indexOf(c.dataset.style) >= 0);
    });
  });
  if (gen.mode === "company" && gen.items.length) renderResults();
  else if (gen.mode === "company" && gen.ctx) renderGenPanel();
  $("#go-co-gen").addEventListener("click", () => startGenerate("company"));
}

// ---------------- 名字评分 ----------------
let scoreForm = { mode: "baby", name: "", gender: "男", date: "", hour: "" };
let scoreState = { ctx: null, wg: null, prog: null, review: null, running: false };

function scoreCtx() {
  const name = scoreForm.name.replace(/\s+/g, "");
  if (!/^[\u4e00-\u9fff]{2,5}$/.test(name)) throw new Error("请输入 2-5 个汉字的名字");
  const mode = scoreForm.mode === "company" ? "company" : "baby";
  const surLen = mode === "company" ? 1
    : (QiMingStrokes.COMPOUND_SURNAMES.indexOf(name.slice(0, 2)) >= 0 ? 2 : 1);
  let birthText = "", baziText = "", xiyongText = "", bu = null;
  if (mode === "baby" && scoreForm.date) {
    const [y, m, d] = scoreForm.date.split("-").map(Number);
    if (y && m && d) {
      const hour = scoreForm.hour === "" ? null : parseInt(scoreForm.hour, 10);
      const chart = LiuYaoBazi.buildChart({
        name, gender: scoreForm.gender === "女" ? "女" : "男", y, m, d, hour
      });
      const xy = QiMingXiyong.analyze(chart);
      birthText = scoreForm.date + (hour === null ? "（时辰不详，按三柱论）"
        : " " + LiuYaoBazi.HOUR_NAMES[((hour + 1) % 24) >> 1]);
      baziText = chart.bazi_text;
      xiyongText = QiMingXiyong.promptText(xy);
      bu = xy.bu;
    }
  }
  return { mode, name, surLen, gender: mode === "baby" ? scoreForm.gender : "",
    birthText, baziText, xiyongText, bu };
}

// 程序评分：姓名 → 三才五格分；公司名 → 总格数理分。aiStrokes 用于缺字兜底重算。
function programScore(ctx, aiStrokes) {
  const wg = QiMingWuge.analyze(ctx.name, { surLen: ctx.surLen, aiStrokes: aiStrokes || {} });
  if (!wg) return { wg: null, score: null };
  const score = ctx.mode === "company" ? LUCK_SCORE[wg.grids.zong.luck] : wg.score;
  return { wg, score };
}

// 供提示词引用的五格摘要（AI 被要求直接采信、禁止重算）
function wugeSummaryText(wg) {
  if (!wg) return "程序未能确定全部笔画，五格暂缺（请自报康熙笔画供参考）。";
  const g = wg.grids;
  return "天" + g.tian.num + " 人" + g.ren.num + "(" + g.ren.luck + ") 地" + g.di.num + "(" + g.di.luck +
    ") 外" + g.wai.num + "(" + g.wai.luck + ") 总" + g.zong.num + "(" + g.zong.luck + ")；" +
    "三才 " + wg.sancai.elements + "（" + wg.sancai.verdict + "）" +
    (wg.unverified.length ? "；笔画未经核验的字：" + wg.unverified.join("、") : "");
}

function scoreCharsHtml(wg) {
  if (!wg) return "";
  return `<div class="nc-char-wx">` + wg.chars.map((c) =>
    `<span class="cwx"><b>${esc(c.ch)}</b><i>${esc(c.t)} · ${c.s}画${c.verified ? "" : "?"}</i></span>`).join("") + `</div>`;
}

async function renderScore() {
  await loadConfig();
  const babyOnly = scoreForm.mode === "baby" ? "" : "display:none";
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>名字评分 <span class="sub">三才五格程序复核 + AI 音义详评</span></h2>
      <label class="field">评分类型</label>
      <div class="mode-row">
        <span class="chip" data-sm="baby">姓名评分</span>
        <span class="chip" data-sm="company">公司名评分</span>
      </div>
      <label class="field">名字（2-5 个汉字）</label>
      <input type="text" id="s-name" maxlength="5" placeholder="例：李沐阳 / 欧阳昊 / 云帆科技">
      <div id="s-baby-extra" style="${babyOnly}">
        <div class="grid2">
          <div>
            <label class="field">性别（影响大运，仅供八字排盘）</label>
            <select id="s-gender"><option value="男">男</option><option value="女">女</option></select>
          </div>
          <div>
            <label class="field">出生日期（选填）</label>
            <input type="date" id="s-date">
          </div>
        </div>
        <label class="field">出生时辰（选填）</label>
        <select id="s-hour">
          <option value="">不知道 / 不填</option>
          ${LiuYaoBazi.HOUR_NAMES.map((n, i) => {
            const h = i === 0 ? 0 : 2 * i - 1;
            return `<option value="${h}">${n}</option>`;
          }).join("")}
        </select>
        <div class="hint">填生辰可加入<b>五行喜用匹配</b>评分项（权重 40%）；不填则评 五格 50% + 音律 25% + 字义 25%。生辰只在本机排盘。</div>
      </div>
      <div id="s-company-extra" style="${scoreForm.mode === "company" ? "" : "display:none"}">
        <div class="hint">公司名以<b>总格数理</b>（40%）+ AI 音律/寓意（60%）评分；三才五格是人名学框架，公司名不取人格地格。</div>
      </div>
      <div class="btn-row">
        <button class="btn primary big" id="s-go">立即评分 →</button>
      </div>
    </div>
    <div id="score-result"></div>
  </section>`;

  $$("[data-sm]").forEach((c) => {
    c.classList.toggle("active", c.dataset.sm === scoreForm.mode);
    c.addEventListener("click", () => {
      scoreForm.mode = c.dataset.sm;
      renderScore();
    });
  });
  const bind = (id, key, ev = "input") => {
    const el = $(id);
    el.value = scoreForm[key];
    el.addEventListener(ev, () => { scoreForm[key] = el.value; });
  };
  bind("#s-name", "name");
  bind("#s-gender", "gender", "change");
  bind("#s-date", "date", "change");
  bind("#s-hour", "hour", "change");
  $("#s-go").addEventListener("click", () => {
    try {
      const ctx = scoreCtx();
      const ps = programScore(ctx);
      scoreState = { ctx, wg: ps.wg, prog: ps.score, review: null, full: null, running: false };
      renderScoreResult();
      if (ps.score === null) toast("部分字笔画待补，可先 AI 详评自报笔画后自动补算");
    } catch (e) { toast(e.message); }
  });
  if (scoreState.ctx) renderScoreResult();
}

function programCardHtml() {
  const { ctx, wg, prog } = scoreState;
  const isCompany = ctx.mode === "company";
  const ring = prog === null
    ? `<div class="ring"><span class="v" style="color:var(--ink-faint)">?</span></div>`
    : ringHtml(prog);
  const body = isCompany
    ? (wg ? `
        <table class="wg-table">
          <tr><th>总格 · 全名笔画之和</th><td class="num">${wg.grids.zong.num}</td>
          <td><span class="luck ${wg.grids.zong.luck}">${wg.grids.zong.luck}</span>
          <span style="color:var(--ink-faint);font-size:11.5px">${esc(wg.grids.zong.desc)}</span></td></tr>
        </table>
        <div class="score-formula">公司名程序分 = 总格数理（${prog}）</div>`
      : `<div class="unverified">存在无法确定笔画的字；AI 详评自报笔画后可自动补算（标注未核验）。</div>`)
    : `<details class="nc-detail" open><summary>三才五格明细（程序复核，康熙笔画）</summary>${wugeDetailHtml(wg)}</details>
       <div class="score-formula">程序分 ${prog}：人格35% + 地格20% + 总格25% + 外格10% + 三才10%（天格承祖不计）</div>`;
  return `
  <div class="name-card">
    <div class="nc-head">
      <div class="nc-name">${esc(ctx.name)}<small>程序复核评分</small></div>
      ${ring}
    </div>
    ${scoreCharsHtml(wg)}
    ${body}
    <div class="nc-btns">
      <button class="btn small ghost" id="s-copy">复制评分报告</button>
      <button class="btn small primary" id="s-ai">${scoreState.review ? "重新 AI 详评" : "AI 详评（音律/字义）→"}</button>
    </div>
  </div>`;
}

function renderScoreResult() {
  const box = $("#score-result");
  if (!box) return;
  box.innerHTML = programCardHtml() + `
    <div class="card" id="s-ai-card" hidden>
      <h2 id="s-ai-title">AI 详评 <span class="sub">流式输出</span></h2>
      <div class="btn-row" style="margin-top:0"><button class="btn ghost small" id="s-stop" style="display:none">停止</button></div>
      <div class="gen-stream" id="s-stream" hidden></div>
      <div id="s-ai-body"></div>
      <div class="err-box" id="s-err" hidden></div>
    </div>`;
  $("#s-copy").addEventListener("click", () => copyText(scoreReportText()));
  $("#s-ai").addEventListener("click", () => startScoreReview());
  if (scoreState.review) renderReviewResult();
}

function scoreReportText() {
  const { ctx, wg, prog, review, full } = scoreState;
  const rows = ["【名字】" + ctx.name + (review && review.pinyin ? "（" + review.pinyin + "）" : "")];
  if (wg) {
    const g = wg.grids;
    rows.push("【康熙笔画】" + wg.chars.map((c) => c.ch + c.s + "画" + (c.verified ? "" : "?")).join("　"));
    if (ctx.mode === "baby") {
      rows.push("【五格】天" + g.tian.num + " 人" + g.ren.num + "(" + g.ren.luck + ") 地" + g.di.num +
        "(" + g.di.luck + ") 外" + g.wai.num + "(" + g.wai.luck + ") 总" + g.zong.num + "(" + g.zong.luck + ")");
      rows.push("【三才】" + wg.sancai.elements + " → " + wg.sancai.verdict + "（" + wg.sancai.note + "）");
    } else {
      rows.push("【总格】" + g.zong.num + "（" + g.zong.luck + "）");
    }
    if (wg.unverified.length) rows.push("（笔画未经核验：" + wg.unverified.join("、") + "）");
  }
  rows.push("【程序分】" + (prog === null ? "无法计算（缺笔画）" : prog + "／100"));
  if (review) {
    if (typeof review.score_sound === "number") rows.push("【AI 音律】" + review.score_sound);
    if (typeof review.score_meaning === "number") rows.push("【AI 字义】" + review.score_meaning);
    if (review.comment) rows.push("【AI 总评】\n" + review.comment);
  }
  if (full) rows.push("【综合评分】" + full.total + "／100（" + full.formula + "）");
  rows.push("（起名建议由 AI 生成，仅供文化参考；笔画以《康熙字典》为准）");
  return rows.join("\n");
}

let scoreCtl = null;

async function startScoreReview() {
  if (scoreState.running) { toast("详评进行中…"); return; }
  const cfg = (await loadConfig()) || { providers: {}, provider: "glm" };
  const pid = cfg.provider || "glm";
  const ctx = scoreState.ctx;
  const system = QiMingPrompts.SYSTEM_SCORE;
  const user = QiMingPrompts.scoreUser(Object.assign({}, ctx, { wugeText: wugeSummaryText(scoreState.wg) }));

  scoreState.running = true;
  const card = $("#s-ai-card");
  card.hidden = false;
  $("#s-ai-body").innerHTML = "";
  const streamBox = $("#s-stream");
  streamBox.hidden = MODE !== "client" || !!nativeStreamHttp();
  const stopBtn = $("#s-stop");
  stopBtn.style.display = (MODE !== "client" || nativeStreamHttp()) ? "" : "none";

  let buf = "", lastPaint = 0;
  const paint = () => { streamBox.textContent = buf; streamBox.scrollTop = streamBox.scrollHeight; };
  stopBtn.addEventListener("click", () => {
    if (scoreCtl) scoreCtl.abort();
    if (nativeStreamCancel) nativeStreamCancel();
  });

  const finish = () => {
    scoreState.running = false;
    scoreCtl = null;
    const title = $("#s-ai-title");
    if (title) title.innerHTML = "AI 详评 <span class='sub'>完成</span>";
    stopBtn.style.display = "none";
  };

  scoreCtl = new AbortController();
  try {
    const text = await llmStream(pid, system, user, (st) => {
      buf = st.content;
      const now = performance.now();
      if (now - lastPaint > 120) { lastPaint = now; paint(); }
    }, scoreCtl);
    const parsed = QiMingParse.review(text);
    if (!parsed.ok) {
      finish();
      $("#s-ai-body").innerHTML = `<div class="err-box">AI 未按约定返回 JSON（${esc(parsed.reason)}），原文如下：</div>
        <div class="fallback-box">${md(text)}</div>`;
      return;
    }
    scoreState.review = parsed.item;
    // 程序分缺笔画时，用 AI 自报笔画补算（标注未核验）
    if (!scoreState.wg && parsed.item.kangxi && parsed.item.kangxi.length === ctx.name.length) {
      const ai = {};
      ctx.name.split("").forEach((c, i) => { if (parsed.item.kangxi[i]) ai[c] = parsed.item.kangxi[i]; });
      const redone = programScore(ctx, ai);
      scoreState.wg = redone.wg;
      scoreState.prog = redone.score;
    }
    // 合成综合分（与生成卡片同权重）
    const item = Object.assign({}, parsed.item, {
      name: ctx.name,
      given: ctx.name.slice(ctx.surLen)
    });
    scoreState.full = enrichItem(item, ctx);
    finish();
    renderScoreResult();  // 程序卡与详评卡一起重绘
    toast("综合评分：" + scoreState.full.total);
  } catch (e) {
    finish();
    if (e.name === "AbortError") { toast("已停止"); return; }
    const errBox = $("#s-err");
    if (errBox) { errBox.hidden = false; errBox.textContent = "详评失败：" + hintFor(e.message, pid); }
  }
}

function renderReviewResult() {
  const { review, full, ctx } = scoreState;
  const body = $("#s-ai-body");
  if (!body || !review) return;
  const parts = (full && full.parts || []).map((p) =>
    `<span class="tag meta">${esc(p.name)} ${p.score}</span>`).join("");
  body.innerHTML = `
    <div class="nc-head" style="margin-top:10px">
      <div class="nc-chips" style="margin-top:0">${parts}</div>
      ${full ? ringHtml(full.total) : ""}
    </div>
    ${review.pinyin ? `<div class="hint" style="margin-top:6px">拼音：${esc(review.pinyin)}</div>` : ""}
    ${full && full.formula ? `<div class="score-formula">综合分权重：${esc(full.formula)}</div>` : ""}
    ${review.comment ? `<div class="fallback-box" style="margin-top:10px">${md(review.comment)}</div>` : ""}
    <div class="score-formula">音律/字义为 AI 自评，五格/数理为程序计算；结果仅供参考。</div>`;
  $("#s-ai-card").hidden = false;
}

// ---------------- 生成流程 ----------------
function babyCtx() {
  const surname = babyForm.surname.trim();
  if (!/^[\u4e00-\u9fff]{1,2}$/.test(surname)) throw new Error("请填写 1-2 个汉字的姓氏");
  const bz = computeBazi();
  const avoid = babyForm.avoid.split(/[,，、\s]+/).map((s) => s.trim()).filter((s) => s.length === 1);
  const lenText = babyForm.len === "single" ? "单名（1 字）" : babyForm.len === "double" ? "双名（2 字）" : "不限（1 或 2 字）";
  return {
    mode: "baby", surname, gender: babyForm.gender, bz, avoid, lenText,
    styles: babyForm.styles.slice(),
    surLen: QiMingStrokes.COMPOUND_SURNAMES.indexOf(surname) >= 0 ? 2 : 1,
    birthText: bz ? babyForm.date + (babyForm.hour === ""
      ? "（时辰不详，按三柱论）"
      : " " + LiuYaoBazi.HOUR_NAMES[((parseInt(babyForm.hour, 10) + 1) % 24) >> 1]) : "",
    baziText: bz ? bz.chart.bazi_text : "",
    xiyongText: bz ? QiMingXiyong.promptText(bz.xiyong) : "",
    bu: bz ? bz.xiyong.bu : null
  };
}

function companyCtx() {
  const lenText = coForm.len === "two" ? "二字" : coForm.len === "three" ? "三字" : "不限";
  return {
    mode: "company", brand: coForm.brand.trim(), industry: coForm.industry,
    lenText, styles: coForm.styles.slice(), surLen: 1, bu: null
  };
}

function renderGenPanel(streamText) {
  const card = $("#gen-card");
  card.hidden = false;
  card.innerHTML = `
    <h2 id="gen-title">生成中 <span class="sub">AI 正在编写候选名…</span></h2>
    <div class="btn-row" style="margin-top:0">
      <button class="btn ghost small" id="stop-gen" style="display:none">停止</button>
    </div>
    <div class="gen-stream" id="gen-stream">${esc(streamText || "")}</div>
    <div class="err-box" id="gen-err" hidden></div>`;
  const stop = $("#stop-gen");
  if (gen.running && (MODE !== "client" || nativeStreamHttp())) stop.style.display = "";
  stop.addEventListener("click", () => {
    if (genCtl) genCtl.abort();
    if (nativeStreamCancel) nativeStreamCancel();
  });
}

let genCtl = null;

/* 通用 LLM 流式请求：服务端走 /api/generate 转发，离线走原生插件/浏览器直连。
 * onDelta({content, reason}) 由调用方自行节流；返回完整文本；
 * 中止时抛 name === "AbortError" 的异常。生成与评分两页共用。 */
async function llmStream(pid, system, user, onDelta, ctl) {
  if (MODE === "client") {
    const plugin = nativeStreamHttp();
    if (plugin) return clientGenerateStream(pid, system, user, onDelta);
    const text = await clientGenerate(pid, system, user);
    if (onDelta) onDelta({ content: text, reason: "" });
    return text;
  }
  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: pid, system, user }),
    signal: ctl ? ctl.signal : undefined,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || "HTTP " + res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    if (onDelta) onDelta({ content: buf, reason: "" });
  }
  return buf;
}

async function startGenerate(mode) {
  if (gen.running) { toast("正在生成中…"); return; }
  let ctx;
  try {
    ctx = mode === "baby" ? babyCtx() : companyCtx();
  } catch (e) { toast(e.message); return; }

  const cfg = (await loadConfig()) || { providers: {}, provider: "glm" };
  const pid = cfg.provider || "glm";
  const system = mode === "baby" ? QiMingPrompts.SYSTEM_BABY : QiMingPrompts.SYSTEM_COMPANY;
  const user = mode === "baby"
    ? QiMingPrompts.babyUser(Object.assign({ exclude: gen.mode === mode ? gen.exclude : [] }, ctx))
    : QiMingPrompts.companyUser(Object.assign({ exclude: gen.mode === mode ? gen.exclude : [] }, ctx));

  gen = { mode, items: [], exclude: gen.mode === mode ? gen.exclude : [], ctx, running: true };
  $("#results").innerHTML = "";
  renderGenPanel(MODE === "client" && !nativeStreamHttp()
    ? "离线直连（浏览器模式）：非流式生成，完整体显示…" : "");

  const streamEl = () => $("#gen-stream");
  let buf = "", lastPaint = 0;
  const paint = () => {
    const el = streamEl();
    if (!el) return;
    el.textContent = buf;
    el.scrollTop = el.scrollHeight;
  };

  const t0 = Date.now();
  const finishRun = () => {
    gen.running = false;
    const title = $("#gen-title");
    if (title) title.innerHTML = "生成完毕 <span class='sub'>用时 " + Math.max(1, Math.round((Date.now() - t0) / 1000)) + "s</span>";
    const stop = $("#stop-gen");
    if (stop) stop.style.display = "none";
  };

  const handle = (text) => {
    const parsed = QiMingParse.candidates(text);
    if (!parsed.ok) {
      finishRun();
      const card = $("#gen-card");
      card.innerHTML = `
        <h2>解析失败 <span class="sub">${esc(parsed.reason)}</span></h2>
        <div class="err-box">AI 未按约定返回 JSON 候选数组。下面是原始输出，可直接阅读：</div>
        <div class="fallback-box">${md(text)}</div>
        <div class="btn-row"><button class="btn ghost" id="retry-gen">再试一次</button></div>`;
      $("#retry-gen").addEventListener("click", () => startGenerate(mode));
      return;
    }
    const items = parsed.items.map((it) => enrichItem(it, gen.ctx));
    gen.items = items;
    gen.exclude = gen.exclude.concat(items.map((x) => x.name));
    finishRun();
    $("#gen-card").hidden = true;
    renderResults();
    toast(`解析成功：${items.length} 个候选` + (parsed.dropped ? `（丢弃 ${parsed.dropped} 项）` : ""));
  };

  genCtl = new AbortController();
  try {
    const text = await llmStream(pid, system, user, (st) => {
      buf = st.content;
      const now = performance.now();
      if (now - lastPaint > 120) { lastPaint = now; paint(); }
    }, genCtl);
    buf = text;
    handle(text);
  } catch (e) {
    finishRun();
    if (e.name === "AbortError") {
      if (buf) handle(buf);
      else toast("已停止");
    } else {
      const errBox = $("#gen-err");
      if (errBox) { errBox.hidden = false; errBox.textContent = "生成失败：" + hintFor(e.message, pid); }
      else toast("生成失败：" + e.message);
    }
  } finally {
    genCtl = null;
  }
}

function hintFor(msg, pid) {
  let out = msg;
  if (/401|403|api.?key|unauthorized/i.test(msg)) {
    out += "\n提示：请到「设置」检查 API Key 是否正确保存。";
  } else if (/429|1113|余额|资源包|quota|rate.?limit/i.test(msg)) {
    out += "\n提示：账户额度不足——Coding Plan 需用开通订阅的账号创建「Coding Plan 类型」密钥；个人 Key 会报余额不足。";
  } else if (/404|model/i.test(msg)) {
    out += "\n提示：请到「设置」核对模型名称。";
  }
  return out;
}

// ---------------- 结果卡片 ----------------
function ringHtml(score) {
  const r = 26, c = 2 * Math.PI * r;
  const color = score >= 90 ? "#a8402f" : score >= 75 ? "#a08018" : score >= 60 ? "#6b6353" : "#9a8f78";
  return `<div class="ring">
    <svg width="64" height="64" viewBox="0 0 64 64">
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(217,205,174,0.5)" stroke-width="5"/>
      <circle cx="32" cy="32" r="${r}" fill="none" stroke="${color}" stroke-width="5"
        stroke-linecap="round" stroke-dasharray="${(score / 100 * c).toFixed(1)} ${c.toFixed(1)}"/>
    </svg>
    <span class="v" style="color:${color}">${score}</span>
  </div>`;
}

function wugeDetailHtml(wg) {
  if (!wg) {
    return `<div class="unverified">名字含未收录且未自报笔画的字，五格无法计算。</div>`;
  }
  const g = wg.grids;
  const rows = [
    ["天格", g.tian, "姓 + 1（祖传，不单独论吉凶）"],
    ["人格", g.ren, "姓末字 + 名首字（主运）"],
    ["地格", g.di, "名字之和（单名 +1，前运）"],
    ["外格", g.wai, wg.compound && !wg.singleGiven ? "姓首 + 名末" : "名末 + 1（副运）"],
    ["总格", g.zong, "全名之和（后运）"]
  ].map(([n, gr, note]) => `
    <tr><th>${n} · <span style="color:var(--ink-faint)">${esc(note)}</span></th>
    <td class="num">${gr.num}</td>
    <td><span class="luck ${gr.luck}">${gr.luck}</span> <span style="color:var(--ink-faint);font-size:11.5px">${esc(gr.desc)}</span></td></tr>`).join("");
  const sc = wg.sancai;
  const unver = wg.unverified.length
    ? `<div class="unverified">笔画未经核验的字：${esc(wg.unverified.join("、"))}（本地康熙表未收录，已按 AI 自报笔画计算）</div>` : "";
  return `
    <table class="wg-table">${rows}</table>
    <div class="sc-line">三才配置：<b>${esc(sc.elements.split("").join("·"))}</b>（天·人 ${esc(sc.pair1)}，人·地 ${esc(sc.pair2)}）→
      <span class="luck ${sc.verdict === "吉" ? "大吉" : sc.verdict === "次吉" ? "吉" : "凶"}">${esc(sc.verdict)}</span>
      <span style="color:var(--ink-faint);font-size:11.5px">（相生=吉、比和=次吉、相克=凶）</span></div>
    <div class="score-formula">三才五格分 ${wg.score}：人格35% + 地格20% + 总格25% + 外格10% + 三才10%（天格不计）</div>
    ${unver}`;
}

function cardHtml(it, idx) {
  const wx = (it.wxChars || []).map((x) =>
    `<span class="cwx"><b class="e-${esc(x.e || "")}">${esc(x.ch)}</b><i>${x.e ? esc(x.e) : "?"}${strokeOf(it, x.ch)}</i></span>`).join("");
  const dupTag = it.dup_rate === "低"
    ? '<span class="tag">重名率：低</span>'
    : `<span class="tag red">重名率：${esc(it.dup_rate)}</span>`;
  const partsLine = (it.parts || []).map((p) =>
    `${esc(p.name)} ${p.score}`).join(" · ");
  return `
  <div class="name-card" data-idx="${idx}">
    <div class="nc-head">
      <div class="nc-name">${esc(it.name)}<small>${esc(it.pinyin || "")}</small></div>
      ${ringHtml(it.total)}
    </div>
    <div class="nc-chips">
      ${dupTag}
      ${(it.parts || []).map((p) => `<span class="tag meta">${esc(p.name)} ${p.score}</span>`).join("")}
    </div>
    <div class="nc-source"><b>出处</b>　${esc(it.source || "—")}</div>
    <div class="nc-meaning">${esc(it.meaning || "")}</div>
    <div class="nc-char-wx">${wx}</div>
    <details class="nc-detail">
      <summary>三才五格明细（程序复核，康熙笔画）</summary>
      ${wugeDetailHtml(it.wuge)}
    </details>
    <div class="nc-btns">
      <button class="btn small ghost" data-act="copy" data-idx="${idx}">复制解读</button>
      <button class="btn small primary" data-act="fav" data-idx="${idx}">♡ 收藏</button>
    </div>
    <div class="score-formula">综合分权重：${esc(it.formula || "")}${partsLine ? "　｜　" + partsLine : ""}</div>
  </div>`;
}

function strokeOf(it, ch) {
  const c = (it.wuge && it.wuge.chars || []).find((x) => x.ch === ch);
  return c ? " · " + c.s + "画" + (c.verified ? "" : "?") : "";
}

function cardText(it) {
  const g = it.wuge && it.wuge.grids;
  const lines = [
    "【名字】" + it.name + (it.pinyin ? "（" + it.pinyin + "）" : ""),
    "【出处】" + (it.source || "—"),
    "【寓意】" + (it.meaning || ""),
    "【逐字五行】" + (it.wxChars || []).map((x) => x.ch + x.e).join(" "),
    "【重名率预估】" + it.dup_rate,
  ];
  if (g) {
    lines.push("【五格】天" + g.tian.num + " 人" + g.ren.num + "(" + g.ren.luck + ") 地" + g.di.num +
      "(" + g.di.luck + ") 外" + g.wai.num + " 总" + g.zong.num + "(" + g.zong.luck + ")");
    lines.push("【三才】" + it.wuge.sancai.elements + " → " + it.wuge.sancai.verdict);
    if (it.wuge.unverified.length) lines.push("（笔画未经核验：" + it.wuge.unverified.join("、") + "）");
  }
  lines.push("【综合评分】" + it.total + "／100（" + (it.formula || "") + "）");
  return lines.join("\n");
}

function renderResults() {
  const box = $("#results");
  if (!box) return;
  if (!gen.items.length) { box.innerHTML = ""; return; }
  box.innerHTML = gen.items.map((it, i) => cardHtml(it, i)).join("") + `
    <div class="btn-row">
      <button class="btn primary big" id="more-gen">再来 10 个（避开已出的 ${gen.exclude.length} 个）</button>
    </div>
    <div class="score-formula" style="text-align:center">
      五行/五格为程序计算，音律/字义为 AI 自评；生成结果仅供参考。
    </div>`;
  $("#more-gen").addEventListener("click", () => startGenerate(gen.mode));
  $$("#results [data-act]").forEach((b) => {
    const it = gen.items[+b.dataset.idx];
    if (!it) return;
    if (b.dataset.act === "copy") b.addEventListener("click", () => copyText(cardText(it)));
    if (b.dataset.act === "fav") b.addEventListener("click", () => addFavorite(it));
  });
}

async function addFavorite(it) {
  const ctx = gen.ctx || { mode: "baby", surLen: 1 };
  const item = {
    mode: ctx.mode === "company" ? "company" : "baby",
    name: it.name,
    given: it.given || it.name.slice(ctx.surLen || (ctx.mode === "company" ? 0 : 1)),
    pinyin: it.pinyin || "",
    source: it.source || "",
    meaning: it.meaning || "",
    wuxing: (it.wxChars || []).map((x) => x.e || ""),
    kangxi: (it.wuge && it.wuge.chars || []).map((c) => c.s),
    dup_rate: it.dup_rate,
    total: it.total,
    formula: it.formula || "",
    parts: (it.parts || []).map((p) => ({ name: p.name, score: p.score })),
    wuge: it.wuge ? {
      grids: {
        tian: it.wuge.grids.tian.num, ren: it.wuge.grids.ren.num, di: it.wuge.grids.di.num,
        wai: it.wuge.grids.wai.num, zong: it.wuge.grids.zong.num
      },
      lucks: {
        ren: it.wuge.grids.ren.luck, di: it.wuge.grids.di.luck,
        wai: it.wuge.grids.wai.luck, zong: it.wuge.grids.zong.luck
      },
      sancai: it.wuge.sancai.elements, sancaiV: it.wuge.sancai.verdict,
      score: it.wuge.score, unverified: it.wuge.unverified
    } : null,
    ctxInfo: {
      gender: ctx.gender || "", birth: ctx.birthText || "",
      bu: (ctx.bu || []).join(""), industry: ctx.industry || ""
    }
  };
  try {
    await api("/api/favorites", { method: "POST", body: { item } });
    toast("已收藏：" + it.name);
  } catch (e) {
    toast(e.message);
  }
}

// ---------------- 收藏夹 ----------------
let favSel = {};

async function renderFavorites() {
  let list = [];
  try { list = (await api("/api/favorites")).favorites; } catch (e) { /* ignore */ }
  favSel = {};
  if (!list.length) {
    app.innerHTML = `<div class="card empty"><div class="big">🔖</div>收藏夹还是空的<br><br>
      <a class="btn primary" href="#/baby" style="text-decoration:none">去起个名字</a></div>`;
    return;
  }
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>收藏夹 <span class="sub">共 ${list.length} 个 · 勾选 2-3 个可对比</span></h2>
      <div id="fav-list">
        ${list.map((f) => `
          <div class="fav-card">
            <input type="checkbox" data-favsel="${esc(f.id)}">
            <div class="fav-name">${esc(f.name)}<small>${esc(f.created)} · ${f.mode === "company" ? "公司名" : "宝宝名"}${f.ctxInfo && f.ctxInfo.bu ? " · 宜补" + esc(f.ctxInfo.bu) : ""}</small></div>
            <span class="fav-score">${f.total != null ? f.total : "—"}</span>
            <button class="fav-del" data-favdel="${esc(f.id)}" title="删除">✕</button>
          </div>`).join("")}
      </div>
      <div class="btn-row">
        <button class="btn ghost" id="fav-copy">复制所选解读</button>
        <button class="btn primary" id="fav-cmp">对比所选</button>
      </div>
      <div id="cmp-box"></div>
    </div>
  </section>`;

  $$("[data-favsel]").forEach((c) =>
    c.addEventListener("change", () => {
      if (c.checked) favSel[c.dataset.favsel] = true; else delete favSel[c.dataset.favsel];
    }));
  $$("[data-favdel]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("删除这个收藏？")) return;
      try { await api("/api/favorites/" + b.dataset.favdel, { method: "DELETE" }); } catch (e) { toast(e.message); }
      renderFavorites();
    }));

  const picked = () => list.filter((f) => favSel[f.id]);
  $("#fav-copy").addEventListener("click", () => {
    const sel = picked();
    if (!sel.length) { toast("先勾选要复制的名字"); return; }
    copyText(sel.map(favText).join("\n\n" + "—".repeat(16) + "\n\n"));
  });
  $("#fav-cmp").addEventListener("click", () => {
    const sel = picked();
    if (sel.length < 2) { toast("对比需要勾选 2 个以上"); return; }
    renderCompare(sel);
  });
}

function favText(f) {
  const lines = [
    "【名字】" + f.name + (f.pinyin ? "（" + f.pinyin + "）" : ""),
    "【出处】" + (f.source || "—"),
    "【寓意】" + (f.meaning || ""),
    "【重名率预估】" + (f.dup_rate || "中"),
  ];
  if (f.wuge && f.wuge.grids) {
    lines.push("【五格】天" + f.wuge.grids.tian + " 人" + f.wuge.grids.ren + "(" + f.wuge.lucks.ren +
      ") 地" + f.wuge.grids.di + "(" + f.wuge.lucks.di + ") 外" + f.wuge.grids.wai + " 总" + f.wuge.grids.zong + "(" + f.wuge.lucks.zong + ")");
    lines.push("【三才】" + f.wuge.sancai + " → " + f.wuge.sancaiV);
  }
  if (f.total != null) lines.push("【综合评分】" + f.total + "／100" + (f.formula ? "（" + f.formula + "）" : ""));
  return lines.join("\n");
}

function renderCompare(sel) {
  const box = $("#cmp-box");
  box.innerHTML = `<div class="cmp-grid" style="margin-top:14px">` + sel.map((f) => {
    const w = f.wuge;
    const wx = (f.wuxing || []).filter(Boolean).join("·");
    return `<div class="cmp-col">
      <h4>${esc(f.name)}<span class="tag">${f.total != null ? f.total + "分" : "—"}</span></h4>
      <div><span class="tag meta">${esc(f.pinyin || "")}</span> ${wx ? `<span class="tag meta">${esc(wx)}</span>` : ""} <span class="tag ${f.dup_rate === "低" ? "" : "red"}">重名${esc(f.dup_rate || "中")}</span></div>
      <div style="margin-top:8px">出处：${esc(f.source || "—")}</div>
      <div>寓意：${esc(f.meaning || "—")}</div>
      ${w && w.grids ? `<div style="margin-top:8px">五格：天${w.grids.tian} 人${w.grids.ren}(${esc(w.lucks.ren)}) 地${w.grids.di}(${esc(w.lucks.di)}) 外${w.grids.wai} 总${w.grids.zong}(${esc(w.lucks.zong)})<br>
        三才：${esc(w.sancai)} → ${esc(w.sancaiV)}；五格分 ${w.score}</div>` : ""}
    </div>`;
  }).join("") + `</div>`;
}

// ---------------- 设置页 ----------------
async function renderSettings() {
  const cfg = await loadConfig(true);
  if (!cfg) { app.innerHTML = '<div class="card"><div class="err-box">无法读取配置</div></div>'; return; }

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>AI 服务 <span class="sub">点标签可切换默认</span></h2>
      ${Object.entries(cfg.providers).map(([pid, p]) => `
        <div class="prov-card ${pid === cfg.provider ? "default" : ""}" data-pid="${pid}">
          <div class="prov-head">
            <span class="name">${esc(p.label)} ${pid === cfg.provider ? '<span class="tag red">默认</span>' : ""}</span>
            <button class="btn small ghost" data-setdefault="${pid}">设为默认</button>
          </div>
          <label class="field">接口地址（Base URL）</label>
          <input type="url" data-f="base" value="${esc(p.base)}" placeholder="https://open.bigmodel.cn/api/coding/paas/v4">
          <div class="grid2 set">
            <div>
              <label class="field">协议</label>
              <select data-f="protocol">
                <option value="openai" ${p.protocol !== "anthropic" ? "selected" : ""}>OpenAI 兼容（/chat/completions）</option>
                <option value="anthropic" ${p.protocol === "anthropic" ? "selected" : ""}>Anthropic 兼容（/v1/messages）</option>
              </select>
            </div>
            <div>
              <label class="field">API Key</label>
              <input type="password" data-f="api_key" placeholder="${p.has_key ? "已保存（留空则不修改）" : "未设置"}" autocomplete="new-password">
            </div>
          </div>
          <label class="field">模型名 <span style="font-weight:400">（可下拉选择或手动输入）</span></label>
          <select data-f="model_select" hidden></select>
          <input type="text" data-f="model" value="${esc(p.model)}" placeholder="如 glm-5.3" style="margin-top:8px">
          <label class="chk-line"><input type="checkbox" data-f="fast" ${p.fast ? "checked" : ""}> 快速模式（关闭深度思考，GLM 出结果更快，默认开）</label>
          <div class="btn-row">
            <button class="btn small ghost" data-fetchmodels="${pid}">获取模型列表</button>
            <button class="btn small ghost" data-test="${pid}">测试连接</button>
          </div>
          <div class="test-line" data-line="${pid}"></div>
        </div>`).join("")}
      <div class="btn-row">
        <button class="btn primary big" id="save-cfg">保存设置</button>
      </div>
    </div>
    <div class="card">
      <h2>说明</h2>
      <div class="hint">
        · 当前运行：<b>${MODE === "server" ? "服务器模式（连本机服务，流式输出）" : "离线模式（App 内计算，直连 AI）"}</b><br>
        · <b>GLM 智谱（Coding Plan）</b>：到 open.bigmodel.cn 用<b>开通了 Coding Plan 的账号</b>创建「Coding Plan 类型」API Key 粘贴到上方；个人类型 Key 会报 429 余额不足。模型默认 glm-5.3，建议保持开启「快速模式」。<br>
        · 八字排盘与三才五格全部在本机计算，出生信息不会发送给 AI 之外的一方；API Key 只保存在本机。<br>
        · 网页版手机使用：<code>python3 app.py --host 0.0.0.0</code> 后，同一 Wi-Fi 下访问本机 IP。
      </div>
    </div>
  </section>`;

  $$("[data-setdefault]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api("/api/config", { method: "POST", body: { provider: b.dataset.setdefault } });
        toast("已设为默认 AI 服务");
        renderSettings();
      } catch (e) { toast(e.message); }
    }));

  function provField(pid, f) {
    const card = $(`.prov-card[data-pid="${pid}"]`);
    return card && $(`[data-f="${f}"]`, card);
  }

  function cachedModels(pid) {
    try { return JSON.parse(localStorage.getItem("qiming.models." + pid) || "[]"); } catch (e) { return []; }
  }
  function cacheModels(pid, ms) {
    try { localStorage.setItem("qiming.models." + pid, JSON.stringify(ms.slice(0, 80))); } catch (e) { /* 忽略 */ }
  }
  function fillModelSelect(card, models) {
    const sel = $('[data-f="model_select"]', card);
    const mi = $('[data-f="model"]', card);
    if (!sel) return;
    if (!models.length) { sel.hidden = true; sel.innerHTML = ""; return; }
    sel.innerHTML = models.map((m) =>
      `<option value="${esc(m)}" ${m === mi.value.trim() ? "selected" : ""}>${esc(m)}</option>`).join("");
    sel.hidden = false;
  }
  function wireModelSelect(card) {
    const sel = $('[data-f="model_select"]', card);
    const mi = $('[data-f="model"]', card);
    if (!sel) return;
    sel.addEventListener("change", () => { if (sel.value) mi.value = sel.value; });
    mi.addEventListener("input", () => {
      Array.from(sel.options).forEach((o) => { o.selected = o.value === mi.value.trim(); });
    });
  }

  $$(".prov-card").forEach((card) => {
    wireModelSelect(card);
    const ms = cachedModels(card.dataset.pid);
    if (ms.length) fillModelSelect(card, ms);
  });

  $$("[data-fetchmodels]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.fetchmodels;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "获取中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        const card = $(`.prov-card[data-pid="${pid}"]`);
        cacheModels(pid, models);
        fillModelSelect(card, models);
        const mi = provField(pid, "model");
        if (models.length && !mi.value.trim()) mi.value = models[0];
        line.textContent = models.length
          ? `✓ 发现 ${models.length} 个模型，已在上方下拉可选`
          : "✗ 未发现可用模型";
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $$("[data-test]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.test;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "测试中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        line.textContent = `✓ 连接正常，可用模型 ${models.length} 个`;
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  async function saveProviderCfg() {
    const providers = {};
    $$(".prov-card").forEach((card) => {
      const pid = card.dataset.pid;
      const get = (f) => {
        const el = $(`[data-f="${f}"]`, card);
        if (!el) return undefined;
        return el.type === "checkbox" ? el.checked : el.value.trim();
      };
      const p = { base: get("base") || "", protocol: get("protocol") || "openai", model: get("model") || "" };
      if (get("fast") !== undefined) p.fast = get("fast");
      const key = get("api_key");
      if (key) p.api_key = key;
      providers[pid] = p;
    });
    const body = { provider: cfg.provider, providers };
    try { await api("/api/config", { method: "POST", body }); } catch (e) { toast(e.message); throw e; }
  }

  $("#save-cfg").addEventListener("click", async () => {
    const btn = $("#save-cfg");
    btn.disabled = true;
    try { await saveProviderCfg(); toast("设置已保存"); } finally { btn.disabled = false; }
  });
}

// ---------------- 启动 ----------------
// 测试钩子（自动化验证离线模式，不影响正常功能）
if (typeof window !== "undefined") {
  window.__qiming = {
    get mode() { return MODE; }, set mode(v) { MODE = v; },
    clientApi, clientGenerate,
    get gen() { return gen; },
    parse: (t) => QiMingParse.candidates(t),
    review: (t) => QiMingParse.review(t),
    // 纯函数直测（无 DOM 环境下验证卡片/明细/复制文本的生成）
    test: {
      cardHtml: (it, i) => cardHtml(it, i),
      cardText: (it) => cardText(it),
      enrichItem: (it, ctx) => enrichItem(it, ctx),
      get babyForm() { return babyForm; }, set babyForm(v) { babyForm = v; },
      get coForm() { return coForm; }, set coForm(v) { coForm = v; },
      get scoreForm() { return scoreForm; }, set scoreForm(v) { scoreForm = v; },
      babyCtx: () => babyCtx(),
      companyCtx: () => companyCtx(),
      scoreCtx: () => scoreCtx(),
      programScore: (ctx, ai) => programScore(ctx, ai),
      wugeSummaryText: (wg) => wugeSummaryText(wg),
      scoreReportText: () => scoreReportText()
    }
  };
}
detectMode().then(route);
