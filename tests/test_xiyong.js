/* 喜用神简化规则引擎测试：node tests/test_xiyong.js */
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "static", "engine.js"));
require(path.join(__dirname, "..", "static", "bazi.js"));
require(path.join(__dirname, "..", "static", "xiyong.js"));
const BZ = globalThis.LiuYaoBazi;
const X = globalThis.QiMingXiyong;

const ELEMS = ["木", "火", "土", "金", "水"];

function analyze(y, m, d, hour, gender) {
  return X.analyze(BZ.buildChart({ name: "测", gender: gender || "男", y, m, d, hour }));
}

// 1) 已知向量：1990-05-23 14:00 男（庚午 辛巳 戊子 己未）
//    日主戊土，巳月本气丙火 → 火生土得令；土3+火2=5 → 身偏强
let x = analyze(1990, 5, 23, 14);
assert.strictEqual(x.dayStem, "戊");
assert.strictEqual(x.dayElem, "土");
assert.strictEqual(x.monthElem, "火", "巳月本气丙火");
assert.strictEqual(x.deling, true, "火生土 → 得令");
assert.strictEqual(x.strength, "偏强");
assert.ok(x.bu.length >= 1 && x.bu.length <= 2, "宜补至多两种");
x.bu.forEach((e) => assert.ok(ELEMS.includes(e), "宜补必须是五行"));
// 偏强候选池 = 我生(金) 我克(水) 克我(木)，按缺失优先：缺木、水1 → [木, 水]
assert.deepStrictEqual(x.bu, ["木", "水"]);
assert.ok(x.reason.includes("宜补"), "判定依据应给出宜补结论");
console.log("✓ 向量1（戊土巳月·身强）: 宜补", x.bu.join("、"), "|", x.strength, x.deling ? "得令" : "不得令");

// 2) 全局不变量：任意日期下规则自洽
const samples = [
  [2000, 1, 1, 12], [2013, 6, 8, 4], [2024, 3, 1, 10], [1985, 11, 20, 22],
  [1995, 9, 15, null], [2008, 2, 6, 8], [2020, 7, 7, 0], [1999, 12, 31, 23]
];
samples.forEach(([y, m, d, h]) => {
  const r = analyze(y, m, d, h);
  assert.ok(["偏强", "中和", "偏弱"].includes(r.strength), y + " 强弱非法");
  assert.ok(r.bu.length >= 1 && r.bu.length <= 2, y + " 宜补数量非法");
  r.bu.forEach((e) => assert.ok(ELEMS.includes(e)));
  const sum = ELEMS.reduce((a, e) => a + r.counts[e], 0);
  assert.strictEqual(sum, h === null ? 6 : 8, y + " 五行字数应为" + (h === null ? 6 : 8));
  // 身弱必补 印（生我者）/ 比（同我者）
  if (r.strength === "偏弱") {
    const SHENG = { "木": "火", "火": "土", "土": "金", "金": "水", "水": "木" };
    const mother = ELEMS.filter((e) => SHENG[e] === r.dayElem)[0];
    r.bu.forEach((e) => assert.ok(e === mother || e === r.dayElem, y + " 身弱宜补印比，实际 " + e));
  }
});
console.log("✓ 8 组抽样自洽（身弱必补印比 / 数量 / 五行合法）");

// 3) 提示词文本
x = analyze(1990, 5, 23, 14);
const t = X.promptText(x);
assert.ok(t.includes("【五行统计】"), "五行统计段");
assert.ok(t.includes("【喜用神"), "喜用神段");
assert.ok(t.includes("木、水"), "宜补内容");
assert.ok(X.RULE_TEXT.includes("简化"), "页面应注明简化规则");
console.log("✓ 提示词文本格式 OK");

console.log("\n喜用神引擎测试全部通过");
