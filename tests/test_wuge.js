/* 三才五格 + 康熙笔画表 单元测试：node tests/test_wuge.js
 * 向量按五格剖象法通行公式手工推演（含复姓/单名分支、AI 兜底分支、81 数理表完整性）。 */
const assert = require("assert");
const path = require("path");

require(path.join(__dirname, "..", "static", "data", "strokes.js"));
require(path.join(__dirname, "..", "static", "data", "wuge.js"));
const W = globalThis.QiMingWuge;
const S = globalThis.QiMingStrokes;

// ---------- 五格向量 1：李沐阳（李7 沐8 阳→陽17，单姓双名） ----------
let r = W.analyze("李沐阳");
assert.ok(r, "李沐阳应能解析");
assert.strictEqual(r.compound, false);
assert.strictEqual(r.singleGiven, false);
assert.strictEqual(r.grids.tian.num, 8, "天格=姓+1");
assert.strictEqual(r.grids.ren.num, 15, "人格=姓末+名首");
assert.strictEqual(r.grids.di.num, 25, "地格=名两字之和");
assert.strictEqual(r.grids.wai.num, 18, "外格=名末+1");
assert.strictEqual(r.grids.zong.num, 32, "总格=全名之和");
assert.strictEqual(r.grids.ren.luck, "大吉", "15 数大吉");
assert.strictEqual(r.grids.zong.luck, "大吉", "32 数大吉");
assert.strictEqual(r.sancai.elements, "金土土", "8→金 15→土 25→土");
assert.strictEqual(r.sancai.pair1, "相生", "土生金");
assert.strictEqual(r.sancai.pair2, "比和", "土土");
assert.strictEqual(r.sancai.verdict, "吉", "无克非全比和 → 吉");
assert.ok(r.score >= 90, "高分样本 " + r.score);
assert.deepStrictEqual(r.unverified, [], "全部字经本地表核验");
console.log("✓ 向量1 李沐阳: 天8 人15 地25 外18 总32 | 三才金土土 吉 |", r.score + "分");

// ---------- 五格向量 2：王小明（王4 小3 明8，单姓双名，三才相克） ----------
r = W.analyze("王小明");
assert.strictEqual(r.grids.tian.num, 5);
assert.strictEqual(r.grids.ren.num, 7);
assert.strictEqual(r.grids.di.num, 11);
assert.strictEqual(r.grids.wai.num, 9, "外格=明8+1");
assert.strictEqual(r.grids.zong.num, 15);
assert.strictEqual(r.sancai.elements, "土金木");
assert.strictEqual(r.sancai.verdict, "凶", "金克木 → 凶");
console.log("✓ 向量2 王小明: 三才土金木（金克木）→ 凶 |", r.score + "分");

// ---------- 五格向量 3：欧阳昊（欧15 阳17 昊8，复姓单名） ----------
r = W.analyze("欧阳昊");
assert.strictEqual(r.compound, true, "复姓自动识别");
assert.strictEqual(r.grids.tian.num, 32, "天格=姓两字之和");
assert.strictEqual(r.grids.ren.num, 25, "人格=姓末+名首");
assert.strictEqual(r.grids.di.num, 9, "地格=单名+1");
assert.strictEqual(r.grids.wai.num, 16, "外格=姓首+1");
assert.strictEqual(r.grids.zong.num, 40);
console.log("✓ 向量3 欧阳昊（复姓单名）: 天32 人25 地9 外16 总40");

// ---------- 五格向量 4：李沐（单姓单名，外格固定 2） ----------
r = W.analyze("李沐");
assert.strictEqual(r.singleGiven, true);
assert.strictEqual(r.grids.di.num, 9, "地格=单名+1");
assert.strictEqual(r.grids.wai.num, 2, "单姓单名外格固定 2");
assert.strictEqual(r.grids.zong.num, 15);
console.log("✓ 向量4 李沐（单姓单名）: 外格固定 2");

// ---------- 康熙表命中 / 兜底 ----------
assert.strictEqual(S.lookup("李"), 7);
assert.strictEqual(S.lookup("沐"), 8);
assert.strictEqual(S.lookup("阳"), 17, "简体阳→陽 17");
assert.strictEqual(S.tradOf("泽"), "澤");
assert.strictEqual(S.lookup("龘"), null, "未收录字返回 null");
r = W.analyze("李龘");
assert.strictEqual(r, null, "无兜底时五格不可算");
r = W.analyze("李龘", { aiStrokes: { "龘": 20 } });
assert.ok(r, "AI 自报笔画兜底");
assert.strictEqual(r.grids.ren.num, 27, "人格=7+20");
assert.deepStrictEqual(r.unverified, ["龘"], "兜底字标注未核验");
console.log("✓ 兜底逻辑: 未收录字以 AI 笔画计算并标注未核验");

// ---------- 81 数理表完整性 ----------
for (let i = 1; i <= 81; i++) {
  assert.ok(W.LUCK_81[i], "缺少 " + i);
  assert.ok(["大吉", "吉", "半吉", "凶", "大凶"].includes(W.LUCK_81[i].l), i + " 吉凶级别非法");
  assert.ok(W.LUCK_81[i].d.length >= 4, i + " 缺断语");
}
const dist = {};
Object.values(W.LUCK_81).forEach((x) => dist[x.l] = (dist[x.l] || 0) + 1);
assert.strictEqual(dist["大吉"] + dist["吉"] + dist["半吉"] + dist["凶"] + dist["大凶"], 81);
// 抽查经典数理
[1, 3, 5, 6, 11, 13, 15, 16, 21, 23, 24, 31, 32, 33, 39, 41, 45, 47, 48, 52, 63, 65, 81].forEach(
  (n) => assert.strictEqual(W.LUCK_81[n].l, "大吉", n + " 应为大吉"));
[2, 4, 12, 26, 36, 40, 43, 46, 49, 50, 53, 54, 55, 56, 59, 60, 62, 64, 66, 69, 70, 72, 74, 76, 78, 79, 80].forEach(
  (n) => assert.strictEqual(W.LUCK_81[n].l, "凶", n + " 应为凶"));
[9, 10, 14, 19, 20, 22, 28, 34, 44].forEach(
  (n) => assert.strictEqual(W.LUCK_81[n].l, "大凶", n + " 应为大凶"));
[27, 29, 30, 38, 58].forEach(
  (n) => assert.strictEqual(W.LUCK_81[n].l, "半吉", n + " 应为半吉"));
assert.strictEqual(W.luckOf(82).l, "大吉", "82 → 归 1");
assert.strictEqual(W.luckOf(163).l, "大吉", "163 → 归 1");
console.log("✓ 81 数理表完整（大吉23 吉16 半吉5 凶28 大凶9），>81 归位正确");

// ---------- 三才五行映射 ----------
assert.strictEqual(W.elementOf(1), "木"); assert.strictEqual(W.elementOf(2), "木");
assert.strictEqual(W.elementOf(3), "火"); assert.strictEqual(W.elementOf(4), "火");
assert.strictEqual(W.elementOf(5), "土"); assert.strictEqual(W.elementOf(6), "土");
assert.strictEqual(W.elementOf(7), "金"); assert.strictEqual(W.elementOf(8), "金");
assert.strictEqual(W.elementOf(9), "水"); assert.strictEqual(W.elementOf(10), "水");
assert.strictEqual(W.sancai(1, 1, 1).verdict, "次吉", "全比和 → 次吉");
assert.strictEqual(W.sancai(1, 3, 5).verdict, "吉", "木生火、火生土 → 吉");
assert.strictEqual(W.sancai(1, 8, 3).verdict, "凶", "金克木 → 凶");
console.log("✓ 三才五行映射与生克判定 OK");

// ---------- 复姓表 ----------
assert.ok(S.COMPOUND_SURNAMES.includes("欧阳"));
assert.ok(S.COMPOUND_SURNAMES.includes("第五"));
assert.ok(!S.COMPOUND_SURNAMES.includes("李王"));
console.log("✓ 复姓识别表 OK");

console.log("\n三才五格/康熙表测试全部通过");
