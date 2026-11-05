/* 启名 · AI 返回 JSON 健壮解析（static/parse.js）
 *
 * LLM 虽被要求输出纯 JSON 数组，实际常带 ```json 围栏、前后闲话或尾逗号。
 * 解析策略：剥围栏 → 截取首个 [ 到最后一个 ] → JSON.parse → 失败则做轻量修复重试
 * → 逐项消毒（字段类型矫正、丢弃缺 name 的项、按 name 去重）。
 * 解析失败时前端降级为原文展示，不抛异常。
 */
(function (global) {
  "use strict";

  var ELEMS = ["金", "木", "水", "火", "土"];

  function stripFences(text) {
    var m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    return m ? m[1] : text;
  }

  // 取首个 [ 到最后一个 ] 的区间；没有数组时尝试对象（可能是 {"candidates":[...]}）
  function slicePayload(text) {
    var t = stripFences(text);
    var a = t.indexOf("["), b = t.lastIndexOf("]");
    if (a >= 0 && b > a) return t.slice(a, b + 1);
    a = t.indexOf("{");
    b = t.lastIndexOf("}");
    if (a >= 0 && b > a) return t.slice(a, b + 1);
    return null;
  }

  function tryParse(s) {
    try { return JSON.parse(s); } catch (e) { return undefined; }
  }

  function repair(s) {
    return s
      .replace(/,\s*([}\]])/g, "$1")           // 尾逗号
      .replace(/[\u201c\u201d\u3010\u3011]/g, function (c) {  // 中文引号→英文（仅键值定界）
        return c === "\u201c" || c === "\u201d" ? '"' : c === "\u3010" ? "" : "";
      })
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/}\s*{/g, "},{")                // 缺逗号黏连的对象（罕见兜底）
      .replace(/\]\s*\[/g, "],[");
  }

  function normalizeWuxing(v) {
    var arr = [];
    if (Array.isArray(v)) {
      arr = v.map(function (x) { return String(x == null ? "" : x).trim(); });
    } else if (typeof v === "string") {
      arr = v.replace(/[\s,、，]/g, "").split("");
    } else if (v && typeof v === "object") {
      arr = Object.keys(v).map(function (k) { return String(v[k]); });
    }
    return arr.map(function (x) {
      return ELEMS.indexOf(x) >= 0 ? x : null;
    });
  }

  function normalizeKangxi(v) {
    var arr;
    if (Array.isArray(v)) {
      arr = v;
    } else if (typeof v === "number") {
      arr = [v];
    } else if (typeof v === "string") {
      arr = v.split(/[\s,，、/]+/);
    } else if (v && typeof v === "object") {
      arr = Object.keys(v).map(function (k) { return v[k]; });
    } else {
      return [];
    }
    return arr.map(function (x) {
      var n = typeof x === "number" ? x : parseFloat(String(x).replace(/[^0-9.]/g, ""));
      return (typeof n === "number" && isFinite(n) && n > 0 && n < 60) ? Math.round(n) : null;
    });
  }

  function clampScore(v) {
    var n = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v));
    if (!isFinite(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function sanitizeItem(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length < 2 || name.length > 12) return null;
    var item = {
      name: name,
      given: typeof raw.given === "string" && raw.given.trim() ? raw.given.trim() : "",
      pinyin: String(raw.pinyin == null ? "" : raw.pinyin).trim().slice(0, 80),
      source: String(raw.source == null ? "" : raw.source).trim().slice(0, 600),
      meaning: String(raw.meaning == null ? "" : raw.meaning).trim().slice(0, 600),
      wuxing: normalizeWuxing(raw.wuxing),
      kangxi: normalizeKangxi(raw.kangxi),
      dup_rate: ["高", "中", "低"].indexOf(raw.dup_rate) >= 0 ? raw.dup_rate : "中",
      score_sound: clampScore(raw.score_sound),
      score_meaning: clampScore(raw.score_meaning)
    };
    return item;
  }

  /* candidates(text) → { ok, items, dropped } 或 { ok:false, reason } */
  function candidates(text) {
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, reason: "空输出" };
    }
    var payload = slicePayload(text);
    if (payload === null) {
      return { ok: false, reason: "未找到 JSON 数组" };
    }
    var data = tryParse(payload);
    if (data === undefined) {
      data = tryParse(repair(payload));
    }
    if (data === undefined) {
      return { ok: false, reason: "JSON 解析失败" };
    }
    // 兼容 {"candidates":[...]} / {"names":[...]} / {"data":[...]} 包装
    if (!Array.isArray(data) && typeof data === "object") {
      var keys = ["candidates", "names", "data", "items", "list"];
      for (var i = 0; i < keys.length; i++) {
        if (Array.isArray(data[keys[i]])) { data = data[keys[i]]; break; }
      }
    }
    if (!Array.isArray(data)) {
      return { ok: false, reason: "顶层不是数组" };
    }
    var seen = {};
    var items = [];
    var dropped = 0;
    data.forEach(function (raw) {
      var it = sanitizeItem(raw);
      if (!it || seen[it.name]) { dropped++; return; }
      seen[it.name] = true;
      items.push(it);
    });
    if (!items.length) {
      return { ok: false, reason: "无合法候选（丢弃 " + dropped + " 项）" };
    }
    return { ok: true, items: items, dropped: dropped };
  }

  global.QiMingParse = { candidates: candidates };
})(typeof window !== "undefined" ? window : globalThis);
