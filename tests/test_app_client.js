/* 离线（client）模式自动化测试：在 Node 中加载 app.js（带极简 DOM 桩）。
 * 覆盖：配置存取（Key 持久化/脱敏）、收藏夹 CRUD、JSON 解析钩子、
 * 以及【回归重点】Capacitor 原生环境下即使 /api/config 返回 200 HTML 也必须判为离线
 * （六爻项目踩过的真坑：WebView 拦截本地路径返回 200 HTML，旧版误判为服务器模式）。
 * 运行：node tests/test_app_client.js [--no-llm] */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const STATIC = (f) => path.join(__dirname, "..", "static", f);

// ---- 极简 DOM/浏览器桩（足够让 app.js 完成初始化） ----
const magic = new Proxy(function () {}, {
  get(t, p) {
    if (p === Symbol.iterator) return () => ({ next: () => ({ done: true }) });
    if (p === "then") return undefined;
    return magic;
  },
  set() { return true; },
  apply() { return magic; }
});

function makeSandbox(mem, opts) {
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    fetch: global.fetch, URLSearchParams, URL, TextDecoder, AbortController,
    navigator: {}, location: { hash: opts && opts.hash || "#/baby" },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k)
    },
    document: magic, confirm: () => true, alert: () => {},
    addEventListener: () => {}, scrollTo: () => {}
  };
  if (opts && opts.capacitor) sb.Capacitor = opts.capacitor;
  if (opts && opts.fetch) sb.fetch = opts.fetch;
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  ["engine.js", "bazi.js", "data/strokes.js", "data/wuge.js", "xiyong.js",
   "prompts.js", "parse.js", "app.js"].forEach((f) =>
    vm.runInContext(fs.readFileSync(STATIC(f), "utf8"), sb));
  return sb;
}

(async () => {
  // ---------- 1) 浏览器离线模式：配置 / 收藏 / 解析 ----------
  const mem = new Map();
  const sb = makeSandbox(mem);
  await new Promise((r) => setTimeout(r, 120));  // 等 detectMode 落定为 client（node 无服务器）
  const Q = sb.__qiming || sb.window.__qiming;
  assert.strictEqual(Q.mode, "client", "无服务器环境应自动进入离线模式");

  // 配置：Key 脱敏读取、留空不覆盖
  await Q.clientApi("/api/config", { method: "POST", body: { providers: { glm: { api_key: "TESTKEY123" } } } });
  let cfg = await Q.clientApi("/api/config");
  assert.strictEqual(cfg.providers.glm.has_key, true);
  assert.strictEqual(cfg.providers.glm.api_key, "", "读取时 Key 必须脱敏");
  await Q.clientApi("/api/config", { method: "POST", body: { providers: { glm: { model: "glm-5.3" } } } });
  assert.strictEqual(JSON.parse(mem.get("qiming.config")).providers.glm.api_key, "TESTKEY123", "空 Key 不应覆盖已存 Key");
  console.log("✓ 离线配置 OK（Key 持久化且读取时脱敏）");

  // 收藏夹：增 / 查 / 去重 / 删
  const favItem = (name) => ({ mode: "baby", name, given: name.slice(1), pinyin: "cè shì",
    source: "自创：测试", meaning: "测试条目", total: 88 });
  const { favorite } = await Q.clientApi("/api/favorites", { method: "POST", body: { item: favItem("李沐阳") } });
  assert.ok(favorite.id && favorite.created);
  const list = await Q.clientApi("/api/favorites");
  assert.strictEqual(list.favorites.length, 1);
  await assert.rejects(() => Q.clientApi("/api/favorites", { method: "POST", body: { item: favItem("李沐阳") } }),
    /已在收藏夹/, "重复收藏应报错");
  await Q.clientApi("/api/favorites/" + favorite.id, { method: "DELETE" });
  assert.strictEqual((await Q.clientApi("/api/favorites")).favorites.length, 0);
  console.log("✓ 离线收藏夹 CRUD OK（含去重）");

  // 解析钩子（与 parse.js 单测互补，验证挂载）
  const pr = Q.parse('```json\n[{"name":"李清晏","given":"清晏","pinyin":"qīng yàn","source":"s","meaning":"m"}]\n```');
  assert.ok(pr.ok && pr.items[0].name === "李清晏");
  console.log("✓ 离线解析钩子 OK");

  // ---------- 1b) 上下文构建 + 评分合成 + 卡片渲染（纯函数直测） ----------
  Q.test.babyForm = { surname: "李", gender: "男", date: "1990-05-23", hour: "13",
    len: "double", styles: ["文雅", "诗意"], avoid: "伟，芳" };
  const ctx = Q.test.babyCtx();
  assert.strictEqual(ctx.surname, "李");
  assert.strictEqual(ctx.surLen, 1);
  assert.ok(ctx.bz, "有生辰应排出八字");
  assert.strictEqual(JSON.stringify(ctx.bu), JSON.stringify(["木", "水"]), "1990-05-23 男 宜补木水");
  assert.strictEqual(JSON.stringify(ctx.avoid), JSON.stringify(["伟", "芳"]), "避讳字解析");
  assert.ok(ctx.birthText.includes("未时"), "生辰文本含时辰");
  assert.ok(ctx.xiyongText.includes("宜补：木、水"), "喜用神文本进入提示词");

  const it = Q.test.enrichItem(pr.items[0] && {
    name: "李沐阳", given: "沐阳", pinyin: "mù yáng",
    source: "《楚辞·九歌》「浴兰汤兮沐芳」", meaning: "沐泽朝阳",
    wuxing: ["木", "水", "火"], kangxi: [7, 8, 17], dup_rate: "低",
    score_sound: 88, score_meaning: 92
  }, ctx);
  assert.ok(it.total >= 0 && it.total <= 100);
  assert.ok(it.wuge, "康熙表全命中时五格必须算出");
  assert.strictEqual(it.wuge.grids.ren.num, 15);
  assert.ok(it.parts.some((p) => p.name === "五行匹配"), "含八字时有五行匹配项");
  assert.ok(it.formula.includes("40%"), "页面明示权重");
  const html = Q.test.cardHtml(it, 0);
  ["李沐阳", "mù yáng", "楚辞", "三才五格明细", "收藏", "重名率", "综合分权重"].forEach(
    (s) => assert.ok(html.includes(s), "卡片缺内容：" + s));
  assert.ok(/ring/.test(html) || /svg/.test(html), "卡片应有环形分");
  const txt = Q.test.cardText(it);
  ["【名字】李沐阳", "【五格】", "【三才】", "【综合评分】"].forEach(
    (s) => assert.ok(txt.includes(s), "复制文本缺：" + s));
  console.log("✓ 评分合成与卡片渲染（纯函数）OK：总分", it.total);

  // 公司模式：无数理之外的权重结构
  Q.test.coForm = { brand: "沈", industry: "科技/互联网", len: "two", styles: ["大气"] };
  const cctx = Q.test.companyCtx();
  assert.strictEqual(cctx.mode, "company");
  assert.strictEqual(cctx.industry, "科技/互联网");
  const cit = Q.test.enrichItem({
    name: "沈星驰", given: "沈星驰", pinyin: "shěn xīng chí",
    source: "自创：星驰电掣", meaning: "迅捷如星", wuxing: ["水", "火", "金"],
    kangxi: [8, 9, 13], dup_rate: "中", score_sound: 82, score_meaning: 80
  }, cctx);
  assert.ok(cit.formula.includes("数理总格40%"), "公司权重：数理总格40%");
  assert.ok(cit.parts.some((p) => p.name === "数理总格"));
  console.log("✓ 公司模式评分 OK：总分", cit.total, "|", cit.formula);

  // ---------- 2) 直连本地真模型（--no-llm 跳过；GLM 指向本机端点仅作测试） ----------
  if (!process.argv.includes("--no-llm")) {
    try {
      await Q.clientApi("/api/config", { method: "POST", body: { providers:
        { glm: { base: "http://127.0.0.1:1234/v1", model: "" } } } });
      const text = await Q.clientGenerate("glm", "你是测试。只输出 [\"ok\"]", "测试");
      assert.ok(text.length > 0, "模型应有返回");
      console.log("✓ 直连本地真模型 OK（%d 字）", text.length);
    } catch (e) {
      if (/fetch failed|ECONNREFUSED|获取模型列表/i.test(String(e))) {
        console.log("ⓘ 本机无 LLM 服务，跳过 LLM 实测：", String(e).slice(0, 80));
      } else throw e;
    }
  }

  // ---------- 3) 回归重点：Capacitor 原生环境强制离线 ----------
  // /api/config 返回 200 + HTML（WebView 拦截本地路径的坑），也必须判为 client
  const mem2 = new Map();
  const appEl = { innerHTML: "", addEventListener: () => {} };
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const sb2 = {
    console, setTimeout, clearTimeout,
    performance: { now: () => Date.now() },
    fetch: async () => ({ ok: true, status: 200,
      headers: { get: () => "text/html" },
      json: async () => { throw new Error("html"); } }),
    URLSearchParams, URL, TextDecoder, AbortController,
    navigator: {}, location: { hash: "#/baby" },
    localStorage: { getItem: (k) => (mem2.has(k) ? mem2.get(k) : null),
      setItem: (k, v) => mem2.set(k, String(v)), removeItem: (k) => mem2.delete(k) },
    document: new Proxy({}, {
      get(t, p) {
        if (p === "getElementById") return (id) => (id === "app" ? appEl : magic);
        return magic;
      }
    }),
    confirm: () => true, alert: () => {},
    addEventListener: () => {}, scrollTo: () => {},
    Capacitor: { isNativePlatform: () => true, Plugins: {} }
  };
  sb2.window = sb2; sb2.globalThis = sb2;
  vm.createContext(sb2);
  ["engine.js", "bazi.js", "data/strokes.js", "data/wuge.js", "xiyong.js",
   "prompts.js", "parse.js", "app.js"].forEach((f) =>
    vm.runInContext(fs.readFileSync(STATIC(f), "utf8"), sb2));
  await new Promise((r) => setTimeout(r, 150));
  const Q2 = sb2.__qiming;
  assert.strictEqual(Q2.mode, "client", "原生环境必须强制离线模式（200 HTML 不得误判为服务器）");
  assert.ok(/宝宝起名/.test(appEl.innerHTML), "起名页在手机环境下应完整渲染");
  assert.ok(/生成 10 个候选名/.test(appEl.innerHTML), "起名页应有生成按钮");
  assert.ok(/避讳字/.test(appEl.innerHTML), "起名页应含避讳字输入");
  assert.ok(/八字/.test(appEl.innerHTML), "起名页应说明八字排盘机制");
  assert.ok(/五行/.test(appEl.innerHTML), "起名页应含五行说明");
  assert.strictEqual(unhandled.length, 0, "渲染过程不应有未捕获异常：" + (unhandled[0] && unhandled[0].message));
  process.off("unhandledRejection", onUnhandled);
  const fav2 = await Q2.clientApi("/api/favorites", { method: "POST",
    body: { item: { mode: "baby", name: "王承宇", given: "承宇", pinyin: "chéng yǔ",
      source: "《楚辞·九章》「云霏霏而承宇」", meaning: "测试" } } });
  assert.ok(fav2.favorite.id, "原生环境收藏可用");
  console.log("✓ 原生环境强制离线模式 OK（回归：200 HTML 不再误判）");
  console.log("✓ 手机环境宝宝起名页渲染 OK（无未捕获异常）");

  // 4) 设置页在原生环境渲染
  const mem3 = new Map();
  const appEl3 = { innerHTML: "", addEventListener: () => {} };
  const sb3 = {
    console, setTimeout, clearTimeout,
    performance: { now: () => Date.now() }, fetch: global.fetch,
    URLSearchParams, URL, TextDecoder, AbortController,
    navigator: {}, location: { hash: "#/settings" },
    localStorage: { getItem: (k) => (mem3.has(k) ? mem3.get(k) : null),
      setItem: (k, v) => mem3.set(k, String(v)), removeItem: (k) => mem3.delete(k) },
    document: new Proxy({}, {
      get(t, p) {
        if (p === "getElementById") return (id) => (id === "app" ? appEl3 : magic);
        return magic;
      }
    }),
    confirm: () => true, alert: () => {},
    addEventListener: () => {}, scrollTo: () => {},
    Capacitor: { isNativePlatform: () => true, Plugins: {} }
  };
  sb3.window = sb3; sb3.globalThis = sb3;
  vm.createContext(sb3);
  ["engine.js", "bazi.js", "data/strokes.js", "data/wuge.js", "xiyong.js",
   "prompts.js", "parse.js", "app.js"].forEach((f) =>
    vm.runInContext(fs.readFileSync(STATIC(f), "utf8"), sb3));
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(/AI 服务/.test(appEl3.innerHTML), "设置页应渲染「AI 服务」区块");
  assert.ok(/GLM/.test(appEl3.innerHTML), "设置页应渲染 GLM 卡片");
  assert.ok(/离线模式/.test(appEl3.innerHTML), "设置页应显示离线模式标识");
  console.log("✓ 手机环境设置页渲染 OK");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
// 注：合规页脚（起名建议由 AI 生成…康熙字典…公安/工商）固定于 index.html，随 App 打包
