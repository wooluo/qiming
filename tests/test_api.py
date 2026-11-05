# -*- coding: utf-8 -*-
"""API 集成测试：静态页 / 生成（stub LLM 流式全链路）/ 收藏夹 CRUD / 配置 / 代理直连回归。

内置一个 stub LLM（OpenAI 兼容 SSE），验证：
- /api/generate 流式转发 AI 候选 JSON（含 ```json 围栏，考验前端解析路径的上游形态）
- stub 收到的 system/user 提示词原样透传（提示词由前端 prompts.js 构建，服务端不篡改）
- /api/favorites 增查重删、/api/config 的 Key 脱敏与留空不覆盖
- 本地地址绕过系统代理直连（Clash 类代理回归）
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["QIMING_DATA_DIR"] = tempfile.mkdtemp(prefix="qiming-test-")
sys.path.insert(0, BASE_DIR)

import app as appmod  # noqa: E402

# stub 返回：带围栏的候选 JSON（与真实 GLM 输出形态一致）
STUB_CANDIDATES = [
    {"name": "李沐阳", "given": "沐阳", "pinyin": "mù yáng",
     "source": "《楚辞·九歌》「浴兰汤兮沐芳，华衣兮若阳」",
     "meaning": "沐泽朝阳", "wuxing": ["木", "水", "火"], "kangxi": [7, 8, 17],
     "dup_rate": "低", "score_sound": 88, "score_meaning": 92},
    {"name": "李清晏", "given": "清晏", "pinyin": "qīng yàn",
     "source": "《诗经》「言笑晏晏」",
     "meaning": "清和安宁", "wuxing": ["木", "水", "土"], "kangxi": [7, 12, 14],
     "dup_rate": "中", "score_sound": 90, "score_meaning": 89},
]
STUB_TEXT = "```json\n" + json.dumps(STUB_CANDIDATES, ensure_ascii=False) + "\n```"


class StubLLM(BaseHTTPRequestHandler):
    last_request = None

    def log_message(self, *a):
        pass

    def do_POST(self):  # chat/completions (SSE)
        length = int(self.headers.get("Content-Length") or 0)
        StubLLM.last_request = json.loads(self.rfile.read(length))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        piece1, piece2 = STUB_TEXT[:40], STUB_TEXT[40:]
        for piece in (piece1, piece2):
            chunk = {"choices": [{"delta": {"content": piece}}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self):  # /models
        body = json.dumps({"data": [{"id": "stub-embedding-x"}, {"id": "stub-model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestAPI(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubLLM)
        threading.Thread(target=cls.stub.serve_forever, daemon=True).start()
        stub_port = cls.stub.server_address[1]

        cfg = json.loads(json.dumps(appmod.DEFAULT_CONFIG))
        cfg["provider"] = "glm"
        cfg["providers"]["glm"]["base"] = "http://127.0.0.1:%d/v1" % stub_port
        cfg["providers"]["glm"]["model"] = ""  # 留空 → 从 /models 自动取（跳过 embedding）
        appmod.save_config(cfg)

        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), appmod.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.stub.shutdown()

    def request(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=15) as resp:
                return resp.read().decode()
        except urllib.error.HTTPError as e:
            err = e.read().decode()
            try:
                err = json.loads(err).get("error", err)
            except ValueError:
                pass
            raise _HttpError(e.code, err)

    def test_01_static(self):
        html = self.request("GET", "/")
        self.assertIn("启名", html)
        self.assertIn("康熙字典", html, "页脚合规文案")
        self.assertIn("公安/工商", html, "页脚合规文案")
        js = self.request("GET", "/static/app.js")
        self.assertIn("startGenerate", js)
        wuge = self.request("GET", "/data/wuge.js")
        self.assertIn("LUCK_81", wuge)
        strokes = self.request("GET", "/static/data/strokes.js")
        self.assertIn("QiMingStrokes", strokes)

    def test_02_generate_stream(self):
        raw = self.request("POST", "/api/generate", {
            "provider": "glm",
            "system": "你是起名顾问，严格输出 JSON 数组。",
            "user": "【姓氏】李\n【性别】男\n【字数偏好】双名"})
        # 两段 SSE 拼接后应还原完整文本
        self.assertEqual(raw, STUB_TEXT)
        body = StubLLM.last_request
        self.assertTrue(body.get("stream"), "应请求流式")
        self.assertEqual(body["model"], "stub-model", "自动选模型应跳过 embedding")
        msgs = body["messages"]
        self.assertEqual(msgs[0]["role"], "system")
        self.assertIn("JSON 数组", msgs[0]["content"])
        self.assertIn("【姓氏】李", msgs[1]["content"])
        self.assertIn("双名", msgs[1]["content"])

    def test_03_generate_400(self):
        with self.assertRaises(_HttpError) as cm:
            self.request("POST", "/api/generate", {"system": "x", "user": ""})
        self.assertEqual(cm.exception.code, 400)
        with self.assertRaises(_HttpError) as cm:
            self.request("POST", "/api/generate", {"provider": "nope", "system": "x", "user": "y"})
        self.assertEqual(cm.exception.code, 400)

    def test_04_favorites_crud(self):
        item = {"mode": "baby", "name": "李沐阳", "given": "沐阳", "pinyin": "mù yáng",
                "source": "《楚辞》「沐芳」", "meaning": "沐泽朝阳"}
        out = json.loads(self.request("POST", "/api/favorites", {"item": item}))
        fid = out["favorite"]["id"]
        self.assertTrue(fid)
        # 重复收藏 → 400
        with self.assertRaises(_HttpError) as cm:
            self.request("POST", "/api/favorites", {"item": item})
        self.assertEqual(cm.exception.code, 400)
        # 非法 mode → 400
        with self.assertRaises(_HttpError) as cm:
            self.request("POST", "/api/favorites", {"item": dict(item, mode="xx", name="另名")})
        self.assertEqual(cm.exception.code, 400)
        # 列表 → 删除 → 二次删除 404
        lst = json.loads(self.request("GET", "/api/favorites"))["favorites"]
        self.assertEqual(len(lst), 1)
        self.assertEqual(lst[0]["name"], "李沐阳")
        self.request("DELETE", "/api/favorites/" + fid)
        with self.assertRaises(_HttpError) as cm:
            self.request("DELETE", "/api/favorites/" + fid)
        self.assertEqual(cm.exception.code, 404)

    def test_05_config_key_masking(self):
        self.request("POST", "/api/config", {"providers": {"glm": {"api_key": "KEY888"}}})
        cfg = json.loads(self.request("GET", "/api/config"))
        self.assertTrue(cfg["providers"]["glm"]["has_key"])
        self.assertEqual(cfg["providers"]["glm"]["api_key"], "", "读取时必须脱敏")
        # 空 Key 提交不应覆盖
        self.request("POST", "/api/config", {"providers": {"glm": {"model": "glm-5.3"}}})
        with open(appmod.CONFIG_PATH, encoding="utf-8") as f:
            raw = json.load(f)
        self.assertEqual(raw["providers"]["glm"]["api_key"], "KEY888")

    def test_06_models(self):
        out = json.loads(self.request("GET", "/api/models?provider=glm"))
        self.assertEqual(out["models"][0], "stub-embedding-x")

    def test_07_resolve_model_skips_embedding(self):
        orig = appmod.fetch_models
        appmod.fetch_models = lambda p, timeout=8: ["text-embedding-nomic-x", "glm-5.3"]
        try:
            self.assertEqual(
                appmod.resolve_model({"model": "", "base": "x", "protocol": "openai"}),
                "glm-5.3")
            self.assertEqual(appmod.resolve_model({"model": "手选模型"}), "手选模型")
        finally:
            appmod.fetch_models = orig

    def test_08_proxy_bypass_local(self):
        # 回归：系统/环境代理存在时，本地地址必须直连（Clash 等代理导致 localhost 502）
        bogus = "http://127.0.0.1:9"
        saved = {k: os.environ.get(k) for k in
                 ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")}
        try:
            for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
                os.environ[k] = bogus
            models = appmod.fetch_models(
                {"base": "http://127.0.0.1:%d/v1" % self.stub.server_address[1],
                 "protocol": "openai"})
            self.assertEqual(models[0], "stub-embedding-x")
            self.assertTrue(appmod._is_local_url("http://localhost:1234/v1"))
            self.assertFalse(appmod._is_local_url("https://open.bigmodel.cn/api/paas/v4"))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class _HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__("HTTP %d: %s" % (code, msg))
        self.code = code


if __name__ == "__main__":
    unittest.main(verbosity=2)
