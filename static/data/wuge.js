/* 启名 · 三才五格计算模块（static/data/wuge.js）
 *
 * 独立程序复核：笔画取自 data/strokes.js 康熙表（未收录字以 AI 自报笔画兜底并标注），
 * 五格按五格剖象法（熊崎氏）通行公式计算，数理吉凶内置完整 1-81 数理表，
 * 三才按天人地三格数取五行、依生克规则判定（相生=吉、比和=次吉、相克=凶）。
 * 本模块与 AI 输出完全解耦：AI 自报笔画仅作缺字兜底。
 *
 * 五格公式（单姓/复姓 × 单名/双名）：
 *   天格 = 姓末字 + 1（单姓）；姓两字之和（复姓）。天格承祖，不单独论吉凶。
 *   人格 = 姓末字 + 名首字。
 *   地格 = 名字数之和（双名）；单名 + 1。
 *   总格 = 全名笔画之和。
 *   外格 = 单姓单名固定 2；单姓双名 = 名末字 + 1；复姓单名 = 姓首字 + 1；复姓双名 = 姓首字 + 名末字。
 * 三才取五行：天人地三格数 mod 10 → 1,2木 3,4火 5,6土 7,8金 9,0水。
 */
(function (global) {
  "use strict";

  var SHENG = { "木": "火", "火": "土", "土": "金", "金": "水", "水": "木" };
  var KE = { "木": "土", "土": "水", "水": "火", "火": "金", "金": "木" };

  /* ---------------- 1-81 数理吉凶表（五格剖象法通行表） ----------------
   * l: 大吉/吉/半吉/凶/大凶；d: 传统数理断语（仅供文化参考） */
  var LUCK_81 = {
    1: { l: "大吉", d: "太极之数，万物开泰" },
    2: { l: "凶", d: "两仪之数，混沌未定" },
    3: { l: "大吉", d: "三才之数，天地人和" },
    4: { l: "凶", d: "四象之数，进退失据" },
    5: { l: "大吉", d: "五行俱全，福禄长寿" },
    6: { l: "大吉", d: "安稳余庆，天赋美德" },
    7: { l: "吉", d: "刚毅果断，勇往直前" },
    8: { l: "吉", d: "意志坚强，勤勉发展" },
    9: { l: "大凶", d: "兴尽凶始，穷乏之数" },
    10: { l: "大凶", d: "万事终局，空虚之数" },
    11: { l: "大吉", d: "枯木逢春，稳健着实" },
    12: { l: "凶", d: "意志薄弱，家庭寂寞" },
    13: { l: "大吉", d: "智略超群，博学多才" },
    14: { l: "大凶", d: "沦落天涯，多破兆之数" },
    15: { l: "大吉", d: "福寿圆满，雅量厚重" },
    16: { l: "大吉", d: "贵人相助，众望所归" },
    17: { l: "吉", d: "突破万难，刚柔兼备" },
    18: { l: "吉", d: "有志竟成，功名可期" },
    19: { l: "大凶", d: "风云蔽月，辛苦重来" },
    20: { l: "大凶", d: "非业破运，空费心力" },
    21: { l: "大吉", d: "明月中天，万物确立" },
    22: { l: "大凶", d: "秋草逢霜，怀才不遇" },
    23: { l: "大吉", d: "旭日东升，壮丽壮观" },
    24: { l: "大吉", d: "家门余庆，金钱丰盈" },
    25: { l: "吉", d: "资性英敏，才能奇特" },
    26: { l: "凶", d: "变怪奇异，波澜重叠" },
    27: { l: "半吉", d: "欲望无止，宜养谦德" },
    28: { l: "大凶", d: "阔水浮萍，遭难之数" },
    29: { l: "半吉", d: "智谋兼备，欲望难足" },
    30: { l: "半吉", d: "吉凶参半，投机之数" },
    31: { l: "大吉", d: "智勇得志，可离清福" },
    32: { l: "大吉", d: "侥幸多望，贵人得助" },
    33: { l: "大吉", d: "旭日升天，鸾凤相会" },
    34: { l: "大凶", d: "破家亡身，见识短小" },
    35: { l: "吉", d: "温和平静，优雅发展" },
    36: { l: "凶", d: "波澜重叠，侠肝义胆" },
    37: { l: "吉", d: "权威显达，忠热踏实" },
    38: { l: "半吉", d: "磨铁成针，刻意经营" },
    39: { l: "大吉", d: "富贵荣华，财帛丰盈" },
    40: { l: "凶", d: "谨慎保安，豪胆迈进" },
    41: { l: "大吉", d: "德望高大，忠爱坚实" },
    42: { l: "凶", d: "博识多能，精通世情" },
    43: { l: "凶", d: "雨夜之花，外祥内苦" },
    44: { l: "大凶", d: "愁眉难展，事不如意" },
    45: { l: "大吉", d: "新生泰和，顺风扬帆" },
    46: { l: "凶", d: "载宝沉舟，浪里淘金" },
    47: { l: "大吉", d: "花开之象，万事如意" },
    48: { l: "大吉", d: "青松立鹤，德智兼备" },
    49: { l: "凶", d: "吉临则吉，凶来则凶" },
    50: { l: "凶", d: "一成一败，吉凶互见" },
    51: { l: "吉", d: "盛衰交加，波澜起伏" },
    52: { l: "大吉", d: "先见之明，理想实现" },
    53: { l: "凶", d: "外祥内忧，先富后贫" },
    54: { l: "凶", d: "多难悲运，忧闷频来" },
    55: { l: "凶", d: "外美内苦，善克难关" },
    56: { l: "凶", d: "浪里行舟，历尽艰辛" },
    57: { l: "吉", d: "寒雪青松，夜莺吟春" },
    58: { l: "半吉", d: "先苦后甘，宽宏扬名" },
    59: { l: "凶", d: "寒蝉悲风，意志宜坚" },
    60: { l: "凶", d: "无谋之人，黑暗无光" },
    61: { l: "吉", d: "名利双收，修德养性" },
    62: { l: "凶", d: "衰败之象，内外不和" },
    63: { l: "大吉", d: "万物化育，繁荣之象" },
    64: { l: "凶", d: "骨肉分离，孤独悲愁" },
    65: { l: "大吉", d: "富贵长寿，室家欢乐" },
    66: { l: "凶", d: "内外不和，多欲失福" },
    67: { l: "吉", d: "通达之数，万商云集" },
    68: { l: "吉", d: "顺风吹帆，智虑周密" },
    69: { l: "凶", d: "非业之数，动摇不安" },
    70: { l: "凶", d: "残菊经霜，暗淡无光" },
    71: { l: "吉", d: "石上金花，内心劳苦" },
    72: { l: "凶", d: "劳苦愁闷，外祥内苦" },
    73: { l: "吉", d: "志高力微，宜养正气" },
    74: { l: "凶", d: "坐食山空，沉迷逸乐" },
    75: { l: "吉", d: "守则可安，进取莫望" },
    76: { l: "凶", d: "倾覆离散，宜守静观" },
    77: { l: "吉", d: "先苦后甜，乐极生悲" },
    78: { l: "凶", d: "晚境凄怆，功德光明" },
    79: { l: "凶", d: "云头望月，身疲力尽" },
    80: { l: "凶", d: "凶星入度，清本缩小" },
    81: { l: "大吉", d: "万物回春，还原复始" }
  };

  // 数 > 81 时按传统归入 1-81：((n - 1) % 81) + 1
  function luckOf(num) {
    var n = ((num - 1) % 81) + 1;
    return LUCK_81[n] || { l: "吉", d: "" };
  }

  // 数 → 五行（1,2木 3,4火 5,6土 7,8金 9,0水）
  function elementOf(num) {
    var r = num % 10;
    if (r === 1 || r === 2) return "木";
    if (r === 3 || r === 4) return "火";
    if (r === 5 || r === 6) return "土";
    if (r === 7 || r === 8) return "金";
    return "水";
  }

  // 两五行关系：比和 / 相生（不区分谁生谁）/ 相克
  function relation(a, b) {
    if (a === b) return "比和";
    if (SHENG[a] === b || SHENG[b] === a) return "相生";
    return "相克";
  }

  /* ---------------- 三才判定（规则推导，非硬编码全量表） ----------------
   * verdict: 吉（有相生无比和克）/ 次吉（全比和）/ 凶（任一相克） */
  function sancai(tian, ren, di) {
    var t = elementOf(tian), r = elementOf(ren), d = elementOf(di);
    var r1 = relation(t, r), r2 = relation(r, d);
    var verdict = "吉";
    if (r1 === "相克" || r2 === "相克") verdict = "凶";
    else if (r1 === "比和" && r2 === "比和") verdict = "次吉";
    return {
      elements: t + r + d,
      tian: t, ren: r, di: d,
      pair1: r1, pair2: r2,
      verdict: verdict,
      note: "天" + t + "·人" + r + "（" + r1 + "），人" + r + "·地" + d + "（" + r2 + "）",
      score: verdict === "吉" ? 100 : verdict === "次吉" ? 85 : 40
    };
  }

  /* ---------------- 五格计算 ----------------
   * analyze(fullName, opts)
   *   opts.surLen    姓氏字数（默认自动识别复姓）
   *   opts.aiStrokes { 字: 笔画 } AI 自报笔画（缺字兜底）
   * 返回 null 表示笔画无法确定（无兜底）。 */
  function analyze(fullName, opts) {
    opts = opts || {};
    var Strokes = global.QiMingStrokes;
    if (!Strokes || typeof fullName !== "string") return null;
    var chars = fullName.replace(/\s+/g, "").split("");
    if (chars.length < 2 || chars.length > 5) return null;

    // 姓氏长度：显式指定 > 复姓表识别 > 1
    var surLen = opts.surLen;
    if (surLen !== 1 && surLen !== 2) {
      var two = chars[0] + chars[1];
      surLen = Strokes.COMPOUND_SURNAMES.indexOf(two) >= 0 ? 2 : 1;
    }
    var sur = chars.slice(0, surLen);
    var given = chars.slice(surLen);
    if (given.length < 1) return null;

    // 逐字笔画：康熙表优先，未命中用 AI 自报兜底
    var aiStrokes = opts.aiStrokes || {};
    var info = chars.map(function (ch) {
      var inf = Strokes.info(ch);
      if (inf.s === null) {
        var a = aiStrokes[ch];
        if (typeof a === "number" && a > 0 && a < 60) {
          inf = { s: Math.round(a), t: inf.t, verified: false };
        }
      }
      return { ch: ch, s: inf.s, t: inf.t, verified: inf.verified };
    });
    if (info.some(function (x) { return x.s === null; })) return null;

    var S = info.map(function (x) { return x.s; });
    var s0 = S[0], sLast = S[surLen - 1];
    var g0 = S[surLen], gLast = S[S.length - 1];

    var tian = surLen === 1 ? s0 + 1 : s0 + sLast;
    var ren = sLast + g0;
    var di = given.length === 1 ? g0 + 1 : g0 + S[surLen + 1];
    var zong = S.reduce(function (a, b) { return a + b; }, 0);
    var wai;
    if (surLen === 1 && given.length === 1) wai = 2;
    else if (surLen === 1) wai = gLast + 1;
    else if (given.length === 1) wai = s0 + 1;
    else wai = s0 + gLast;

    function grid(num, name, weighted) {
      var lk = luckOf(num);
      return { name: name, num: num, luck: lk.l, desc: lk.d, weighted: !!weighted };
    }

    var sc = sancai(tian, ren, di);
    // 综合分：人格35% 地格20% 总格25% 外格10% 三才10%（天格承祖不计）
    var luckScore = { "大吉": 100, "吉": 85, "半吉": 65, "凶": 40, "大凶": 15 };
    var score = Math.round(
      luckScore[luckOf(ren).l] * 0.35 +
      luckScore[luckOf(di).l] * 0.20 +
      luckScore[luckOf(zong).l] * 0.25 +
      luckScore[luckOf(wai).l] * 0.10 +
      sc.score * 0.10);

    return {
      name: fullName,
      compound: surLen === 2,
      singleGiven: given.length === 1,
      chars: info,
      unverified: info.filter(function (x) { return !x.verified; }).map(function (x) { return x.ch; }),
      grids: {
        tian: grid(tian, "天格", false),
        ren: grid(ren, "人格", true),
        di: grid(di, "地格", true),
        wai: grid(wai, "外格", true),
        zong: grid(zong, "总格", true)
      },
      sancai: sc,
      score: score
    };
  }

  global.QiMingWuge = {
    LUCK_81: LUCK_81,
    luckOf: luckOf,
    elementOf: elementOf,
    relation: relation,
    sancai: sancai,
    analyze: analyze
  };
})(typeof window !== "undefined" ? window : globalThis);
