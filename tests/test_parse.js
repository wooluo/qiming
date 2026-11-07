/* AI 返回 JSON 健壮解析测试：node tests/test_parse.js
 * 覆盖：纯净输出 / ```json 围栏 / 前后闲话 / 尾逗号 / 对象包装 / 字段脏数据 / 去重 / 纯文本失败 */
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "static", "parse.js"));
const P = globalThis.QiMingParse;

const ITEM = (over) => Object.assign({
  name: "李沐阳", given: "沐阳", pinyin: "mù yáng",
  source: "《楚辞·九歌》「浴兰汤兮沐芳」",
  meaning: "沐泽朝阳，温润而明", wuxing: ["木", "水", "火"],
  kangxi: [7, 8, 17], dup_rate: "低", score_sound: 88, score_meaning: 92
}, over || {});

// 1) 纯净 JSON 数组
let r = P.candidates(JSON.stringify([ITEM(), ITEM({ name: "李清晏", given: "清晏" })]));
assert.ok(r.ok);
assert.strictEqual(r.items.length, 2);
assert.strictEqual(r.items[0].name, "李沐阳");
assert.deepStrictEqual(r.items[0].wuxing, ["木", "水", "火"]);
assert.deepStrictEqual(r.items[0].kangxi, [7, 8, 17]);
assert.strictEqual(r.items[0].dup_rate, "低");
console.log("✓ 纯净 JSON 数组解析 OK");

// 2) ```json 围栏 + 前后闲话
r = P.candidates("好的，以下是 10 个候选名：\n```json\n[" +
  JSON.stringify(ITEM()) + "," + JSON.stringify(ITEM({ name: "李清晏" })) + "]\n```\n希望你喜欢！");
assert.ok(r.ok, "围栏输出应解析成功");
assert.strictEqual(r.items.length, 2);
console.log("✓ 围栏 + 闲话剥离 OK");

// 3) 尾逗号修复
r = P.candidates("[" + JSON.stringify(ITEM()) + ",]");
assert.ok(r.ok, "尾逗号应被修复");
assert.strictEqual(r.items.length, 1);
console.log("✓ 尾逗号修复 OK");

// 4) 对象包装 {"candidates": [...]}
r = P.candidates('{"candidates": [' + JSON.stringify(ITEM()) + "]}");
assert.ok(r.ok);
assert.strictEqual(r.items[0].name, "李沐阳");
console.log("✓ 对象包装解包 OK");

// 5) 字段脏数据：kangxi 字符串、分数越界、非法重名率、wuxing 带杂质
r = P.candidates(JSON.stringify([ITEM({
  kangxi: "7, 8, 17", score_sound: 150, score_meaning: "92",
  dup_rate: "极高", wuxing: ["木", "water", "火"]
})]));
assert.ok(r.ok);
assert.deepStrictEqual(r.items[0].kangxi, [7, 8, 17], "字符串笔画应转数组");
assert.strictEqual(r.items[0].score_sound, 100, "150 应钳到 100");
assert.strictEqual(r.items[0].score_meaning, 92, "数字字符串应转数值");
assert.strictEqual(r.items[0].dup_rate, "中", "非法重名率回退「中」");
assert.deepStrictEqual(r.items[0].wuxing, ["木", null, "火"], "非法五行置 null");
console.log("✓ 字段脏数据消毒 OK");

// 6) 缺 name / 空 name / 非对象项被丢弃；同名去重
r = P.candidates(JSON.stringify([ITEM(), { given: "无名" }, "垃圾", ITEM(), ITEM({ name: "李" })]));
assert.ok(r.ok);
assert.strictEqual(r.items.length, 1, "仅 1 项合法");
assert.strictEqual(r.dropped, 4);
console.log("✓ 非法项丢弃与去重 OK");

// 7) 失败分支：无数组 / 纯闲话 / 空串 / 全非法
assert.ok(!P.candidates("抱歉，我无法完成这个任务。").ok);
assert.ok(!P.candidates("").ok);
assert.ok(!P.candidates(null).ok);
assert.ok(!P.candidates("[{\"given\":\"x\"}]").ok, "全部缺 name 应失败");
console.log("✓ 失败分支（原文降级展示的前提）OK");

// 8) 长度异常防护
r = P.candidates(JSON.stringify([ITEM({ name: "李".repeat(20) })]));
assert.ok(!r.ok || r.items.length === 0, "超长 name 应被丢弃");
console.log("✓ 超长字段防护 OK");

// ---------- 评分详评 review()：单对象解析 ----------
const RV = (over) => Object.assign({
  pinyin: "lǐ mù yáng", wuxing: ["木", "水", "火"], kangxi: [7, 8, 17],
  score_sound: 88, score_meaning: 92, comment: "## 音律\n声调有致。\n## 字义\n沐泽朝阳。"
}, over || {});

r = P.review("```json\n" + JSON.stringify(RV()) + "\n```\n希望有帮助！");
assert.ok(r.ok, "围栏对象应解析成功");
assert.strictEqual(r.item.pinyin, "lǐ mù yáng");
assert.deepStrictEqual(r.item.wuxing, ["木", "水", "火"]);
assert.deepStrictEqual(r.item.kangxi, [7, 8, 17]);
assert.strictEqual(r.item.score_sound, 88);
assert.ok(r.item.comment.includes("音律"));
console.log("✓ 评分详评对象解析（围栏）OK");

// 脏数据：分数越界 / kangxi 字符串 / wuxing 带杂质 / comment 超长
r = P.review(JSON.stringify(RV({
  score_sound: 200, score_meaning: "85", kangxi: "7,8,17", wuxing: ["木", "x", 3]
})));
assert.ok(r.ok);
assert.strictEqual(r.item.score_sound, 100, "200 钳到 100");
assert.strictEqual(r.item.score_meaning, 85, "数字字符串转数值");
assert.deepStrictEqual(r.item.kangxi, [7, 8, 17]);
assert.deepStrictEqual(r.item.wuxing, ["木", null, null], "非法五行置 null");
console.log("✓ 评分详评脏数据消毒 OK");

// 失败分支：无数组对象 / 纯闲话 / 空串 / 顶层数组
assert.ok(!P.review("这个问题无法评估。").ok);
assert.ok(!P.review("").ok);
assert.ok(!P.review(null).ok);
assert.ok(!P.review("[1,2,3]").ok, "顶层数组不是详评对象");
console.log("✓ 评分详评失败分支 OK");

console.log("\nAI JSON 解析健壮性测试全部通过");
