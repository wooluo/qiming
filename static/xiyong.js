/* 启名 · 八字喜用神简化规则引擎（static/xiyong.js）
 *
 * 依赖 bazi.js 排出的命盘（LiuYaoBazi.buildChart 的结果），给出「宜补五行」排序。
 * 说明：子平取用神本需综合全局，此处采用行业通行的【扶抑简化规则】并在页面明示：
 *   1. 统计八字五行（本气）；找出缺失 / 最弱之行；
 *   2. 判断日主是否得令（月支本气与日主同五行或生日主）；
 *   3. 日主偏弱 → 宜补「生我者（印）」与「同我者（比劫）」；
 *      日主偏强 → 宜泄耗「我生者（食伤）」优先，其次「我克者（财）」「克我者（官杀）」；
 *      中和     → 补全局最弱 / 缺失之行；
 *   4. 候选按「缺失优先、字数少者优先」排序，至多取两种。
 */
(function (global) {
  "use strict";

  var SHENG = { "木": "火", "火": "土", "土": "金", "金": "水", "水": "木" };  // A生B
  var ELEMS = ["木", "火", "土", "金", "水"];

  var RULE_TEXT = "喜用神采用行业通行的扶抑简化规则：统计八字五行 → 看日主是否得令（月支本气）→ " +
    "身弱宜补印比（生我、同我），身强宜泄耗（我生、我克、克我），中和则补最弱。至多两种，仅为起名参考。";

  // chart: LiuYaoBazi.buildChart 的返回值
  function analyze(chart) {
    var counts = chart.counts;                      // {金,木,水,火,土}（缺时辰按六字）
    var dayElem = chart.pillars.day.stem_elem;      // 日主五行
    var yin = ELEMS.filter(function (e) { return SHENG[e] === dayElem; })[0]; // 生我者
    var monthElem = chart.pillars.month.cz.length
      ? stemElemOf(chart.pillars.month.cz[0]) : chart.pillars.month.branch_elem; // 月支本气五行
    var deling = (monthElem === dayElem || monthElem === yin);

    // 扶抑判分：同我+生我 字数，得令 +2
    var support = counts[dayElem] + counts[yin];
    var score = support + (deling ? 2 : 0);
    var strength = score >= 5 ? "偏强" : score <= 3 ? "偏弱" : "中和";

    // 候选池
    var pool = [];
    if (strength === "偏弱") {
      pool = [yin, dayElem];                        // 印、比劫
    } else if (strength === "偏强") {
      pool = [SHENG[dayElem], KE_map(dayElem), KE_INV(dayElem)]; // 食伤、财、官杀
    } else {
      pool = ELEMS.slice();                         // 中和：全部五行按弱补
    }

    // 排序：缺失优先 → 字数少者优先；去重后至多两种
    var uniq = pool.filter(function (e, i) { return pool.indexOf(e) === i; });
    uniq.sort(function (a, b) {
      var ma = counts[a], mb = counts[b];
      return ma - mb;
    });
    var bu = uniq.slice(0, 2);

    var missing = ELEMS.filter(function (e) { return counts[e] === 0; });
    var reason = "日主" + chart.pillars.day.stem + dayElem + "，生于" + chart.pillars.month.branch +
      "月（本气" + monthElem + "），" + (deling ? "得令" : "不得令") +
      "；同我+生我共 " + support + " 字，判定身" + strength.slice(1) + "，宜补：" + bu.join("、") + "。";

    return {
      counts: counts,
      missing: missing,
      dayElem: dayElem,
      dayStem: chart.pillars.day.stem,
      monthElem: monthElem,
      deling: deling,
      support: support,
      strength: strength,
      bu: bu,
      reason: reason,
      ruleText: RULE_TEXT
    };
  }

  // 天干 → 五行（与 bazi.js 的 STEM_ELEM 一致，这里独立实现避免依赖内部变量）
  function stemElemOf(stem) {
    var STEMS = "甲乙丙丁戊己庚辛壬癸";
    var ELEM = ["木", "木", "火", "火", "土", "土", "金", "金", "水", "水"];
    var i = STEMS.indexOf(stem);
    return i >= 0 ? ELEM[i] : "土";
  }

  function KE_map(a) {  // A克B（我克者=财）
    return { "木": "土", "土": "水", "水": "火", "火": "金", "金": "木" }[a];
  }

  function KE_INV(a) {  // 克A者（官杀）
    return { "木": "金", "土": "木", "水": "土", "火": "水", "金": "火" }[a];
  }

  // 供提示词使用的文本摘要
  function promptText(x) {
    var cnt = ELEMS.map(function (e) { return e + x.counts[e]; }).join("、");
    return "【五行统计】" + cnt + (x.missing.length ? "（缺" + x.missing.join("、") + "）" : "（五行不缺）") +
      "\n【喜用神（程序按简化规则判定，直接采信）】宜补：" + x.bu.join("、") +
      "\n【判定依据】" + x.reason;
  }

  global.QiMingXiyong = {
    analyze: analyze,
    promptText: promptText,
    RULE_TEXT: RULE_TEXT
  };
})(typeof window !== "undefined" ? window : globalThis);
