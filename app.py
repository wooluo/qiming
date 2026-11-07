#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""启名 · AI 起名 本地服务（Python 标准库，零依赖）

- 宝宝/公司起名：前端排八字（bazi.js 单一计算源）→ 提示词 → GLM 流式生成 10 候选
- 收藏夹本地存档（data/favorites.json）；代理 LLM 流式输出（OpenAI/Anthropic 兼容）
- 三才五格由前端程序复核（data/wuge.js），与 AI 输出解耦

用法：
    python3 app.py                # http://127.0.0.1:8774
    python3 app.py --host 0.0.0.0 # 局域网内手机也可访问
"""
import argparse
import json
import os
import random
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))

DATA_DIR = os.environ.get("QIMING_DATA_DIR", os.path.join(BASE, "data"))
STATIC_DIR = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
FAVORITES_PATH = os.path.join(DATA_DIR, "favorites.json")
_LOCK = threading.RLock()

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".ico": "image/x-icon"}

DEFAULT_CONFIG = {
    "provider": "glm",
    "providers": {
        "glm": {
            "label": "GLM 智谱（Coding Plan）", "protocol": "openai",
            "base": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-5.3",
            "api_key": "", "fast": True,
        },
    },
}


# ---------------------------------------------------------------- 存取工具

def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_config():
    cfg = _load_json(CONFIG_PATH, {})
    if not isinstance(cfg, dict):
        cfg = {}
    out = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    out["provider"] = cfg.get("provider", out["provider"])
    for pid, p in (cfg.get("providers") or {}).items():
        if pid in out["providers"] and isinstance(p, dict):
            for k in ("label", "protocol", "base", "model"):
                if isinstance(p.get(k), str):
                    out["providers"][pid][k] = p[k]
            if isinstance(p.get("fast"), bool):
                out["providers"][pid]["fast"] = p["fast"]
            if isinstance(p.get("api_key"), str) and p["api_key"]:
                out["providers"][pid]["api_key"] = p["api_key"]
        elif isinstance(p, dict):  # 用户自定义 provider
            out["providers"][pid] = {
                "label": p.get("label") or pid, "protocol": p.get("protocol") or "openai",
                "base": p.get("base") or "", "model": p.get("model") or "",
                "api_key": p.get("api_key") or "", "fast": bool(p.get("fast"))}
    if out["provider"] not in out["providers"]:
        out["provider"] = "glm"
    return out


def save_config(cfg):
    with _LOCK:
        _save_json_atomic(CONFIG_PATH, cfg)


def load_favorites():
    data = _load_json(FAVORITES_PATH, [])
    return data if isinstance(data, list) else []


def save_favorites(items):
    _save_json_atomic(FAVORITES_PATH, items)


# ---------------------------------------------------------------- LLM 上游

def _is_local_url(url):
    """本地/回环地址判断（这些地址必须绕过系统代理直连）。"""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or host.endswith(".local")


# 本地直连 opener（无视系统代理，否则 Clash 类代理会对 localhost 返回 502）
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def smart_urlopen(req, timeout):
    """本地地址直连，远程地址尊重环境/系统代理。"""
    if _is_local_url(req.full_url):
        return _DIRECT_OPENER.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_models(pcfg, timeout=8):
    base = (pcfg.get("base") or "").rstrip("/")
    if not base:
        return []
    url = base + ("/v1/models" if pcfg.get("protocol") == "anthropic" else "/models")
    headers = {}
    key = pcfg.get("api_key") or ""
    if key:
        headers["Authorization"] = "Bearer " + key
        headers["x-api-key"] = key
    req = urllib.request.Request(url, headers=headers, method="GET")
    with smart_urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    ids = []
    for item in data.get("data", []):
        mid = item.get("id") if isinstance(item, dict) else None
        if mid:
            ids.append(mid)
    return ids


# 自动选模型时排除非对话模型（embedding/OCR/语音等）
_NON_CHAT_MODEL = re.compile(r"embed|rerank|ocr|whisper|speech|tts|stt|audio|clip", re.I)


def resolve_model(pcfg):
    model = (pcfg.get("model") or "").strip()
    if model:
        return model
    try:
        models = fetch_models(pcfg)
    except Exception:
        models = []
    chat = [m for m in models if not _NON_CHAT_MODEL.search(m)]
    pool = chat or models
    return pool[0] if pool else ""


def open_upstream(pcfg, model, system, user, temperature=0.8):
    base = (pcfg.get("base") or "").rstrip("/")
    key = pcfg.get("api_key") or ""
    if pcfg.get("protocol") == "anthropic":
        url = base + "/v1/messages"
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if key:
            headers["x-api-key"] = key
            headers["Authorization"] = "Bearer " + key
        payload = {"model": model, "max_tokens": 8192, "temperature": temperature,
                   "system": system, "stream": True,
                   "messages": [{"role": "user", "content": user}]}
    else:
        url = base + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        payload = {"model": model, "temperature": temperature, "stream": True,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}]}
    # 快速模式：智谱系端点关闭深度思考，显著缩短等待
    if pcfg.get("fast") and re.search(r"(bigmodel|z\.ai)", base):
        payload["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    return smart_urlopen(req, timeout=600)


def _extract_full_text(obj):
    try:
        if "choices" in obj:
            return obj["choices"][0].get("message", {}).get("content") or ""
        if isinstance(obj.get("content"), list):
            return "".join(b.get("text", "") for b in obj["content"] if isinstance(b, dict))
    except Exception:
        pass
    return ""


def iter_deltas(resp):
    """把上游 SSE/JSON 响应解析成文本增量（兼容 OpenAI 与 Anthropic 两种事件格式）。"""
    ct = (resp.headers.get("content-type") or "").lower()
    if "event-stream" not in ct:
        yield _extract_full_text(json.loads(resp.read().decode("utf-8")))
        return
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        choices = obj.get("choices")
        if isinstance(choices, list) and choices:
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield text
            continue
        if obj.get("type") == "content_block_delta":
            text = (obj.get("delta") or {}).get("text")
            if text:
                yield text


# ---------------------------------------------------------------- 请求校验

def _valid_fav_item(it):
    """收藏项最小合法性：mode + name + given + pinyin + source + meaning。"""
    if not isinstance(it, dict):
        return False
    if it.get("mode") not in ("baby", "company"):
        return False
    for k in ("name", "given", "pinyin", "source", "meaning"):
        v = it.get(k)
        if not isinstance(v, str) or not v.strip() or len(v) > 600:
            return False
    return True


# ---------------------------------------------------------------- HTTP Handler

class Handler(BaseHTTPRequestHandler):
    server_version = "QiMing/1.0"

    def log_message(self, fmt, *args):  # 静默常规访问日志
        pass

    # ---------- 基础工具 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 1 << 20:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self._send_json({"error": "not found"}, 404)
            return
        self._send_file(full)

    # ---------- 路由 ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            cfg = load_config()
            for p in cfg["providers"].values():
                p["has_key"] = bool(p.get("api_key"))
                p["api_key"] = ""
            self._send_json(cfg)
        elif path == "/api/favorites":
            with _LOCK:
                items = load_favorites()
            self._send_json({"favorites": items})
        elif path == "/api/models":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            pid = (qs.get("provider") or [""])[0]
            cfg = load_config()
            pcfg = cfg["providers"].get(pid)
            if not pcfg:
                self._send_json({"error": "未知 provider"}, 400)
                return
            try:
                self._send_json({"models": fetch_models(pcfg)})
            except Exception as e:
                self._send_json({"error": "获取模型列表失败：%s" % e}, 502)
        elif path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
        else:  # 静态资源（相对路径或 /static/ 均可，供网页与 APK 复用同一套前端）
            rel = path.lstrip("/")
            if not rel or rel == "index.html":
                self._send_file(os.path.join(STATIC_DIR, "index.html"))
            elif rel == "favicon.ico":
                self.send_response(204)
                self.end_headers()
            else:
                if rel.startswith("static/"):
                    rel = rel[len("static/"):]
                self._serve_static(rel)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/generate":
            self._handle_generate()
        elif path == "/api/favorites":
            self._handle_fav_add()
        elif path == "/api/config":
            self._handle_config()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/favorites/([\w-]+)$", path)
        if not m:
            self._send_json({"error": "not found"}, 404)
            return
        fid = m.group(1)
        with _LOCK:
            items = load_favorites()
            remain = [x for x in items if x.get("id") != fid]
            if len(remain) == len(items):
                self._send_json({"error": "收藏不存在"}, 404)
                return
            save_favorites(remain)
        self._send_json({"ok": True})

    # ---------- 业务 ----------
    def _handle_config(self):
        body = self._read_json()
        with _LOCK:
            cfg = load_config()
            if body.get("provider") in cfg["providers"]:
                cfg["provider"] = body["provider"]
            for pid, p in (body.get("providers") or {}).items():
                if not isinstance(p, dict) or pid not in cfg["providers"]:
                    continue
                tgt = cfg["providers"][pid]
                for k in ("label", "protocol", "base", "model"):
                    if isinstance(p.get(k), str):
                        tgt[k] = p[k].strip()
                if p.get("protocol") not in ("openai", "anthropic"):
                    tgt["protocol"] = "openai"
                if isinstance(p.get("fast"), bool):
                    tgt["fast"] = p["fast"]
                key = p.get("api_key")
                if isinstance(key, str) and key.strip():
                    tgt["api_key"] = key.strip()
            save_config(cfg)
        self._send_json({"ok": True})

    def _handle_fav_add(self):
        body = self._read_json()
        it = body.get("item")
        if not _valid_fav_item(it):
            self._send_json({"error": "收藏数据不合法"}, 400)
            return
        item = dict(it)
        item["id"] = datetime.now().strftime("%Y%m%d%H%M%S") + "-%04d" % random.randint(0, 9999)
        item["created"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with _LOCK:
            items = load_favorites()
            if any(x.get("name") == item["name"] and x.get("mode") == item["mode"]
                   for x in items):
                self._send_json({"error": "该名字已在收藏夹中"}, 400)
                return
            items.insert(0, item)
            save_favorites(items)
        self._send_json({"favorite": item})

    def _handle_generate(self):
        body = self._read_json()
        cfg = load_config()
        pid = body.get("provider") or cfg.get("provider")
        pcfg = cfg["providers"].get(pid)
        if not pcfg:
            self._send_json({"error": "未知 provider：%s" % pid}, 400)
            return
        system = body.get("system") or ""
        user = body.get("user") or ""
        if not (isinstance(system, str) and isinstance(user, str) and system and user):
            self._send_json({"error": "缺少提示词（system/user）"}, 400)
            return
        if len(system) > 16000 or len(user) > 16000:
            self._send_json({"error": "提示词过长"}, 400)
            return

        model = resolve_model(pcfg)
        if not model:
            self._send_json({"error": "未配置模型名，且无法从 %s 获取模型列表。请在设置里填写模型。"
                                      % pcfg.get("label", pid)}, 502)
            return
        try:
            resp = open_upstream(pcfg, model, system, user)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                detail = ""
            self._send_json({"error": "上游返回 HTTP %d：%s" % (e.code, detail)}, 502)
            return
        except Exception as e:
            self._send_json({"error": "无法连接 %s：%s（请检查网络与接口地址）"
                                      % (pcfg.get("label", pid), e)}, 502)
            return

        # 上游 OK：向浏览器流式转发（HTTP/1.0 风格：无 Content-Length，关连接即结束）
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            for delta in iter_deltas(resp):
                if not delta:
                    continue
                self.wfile.write(delta.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器中断生成
        except Exception as e:
            tail = "\n[上游流中断：%s]" % e
            try:
                self.wfile.write(tail.encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _handle_generate_options(self):  # 预留：CORS 预检（本地工具不需要）
        self.send_response(204)
        self.end_headers()


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="启名 · AI 起名 本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8774)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        save_config(json.loads(json.dumps(DEFAULT_CONFIG)))
    if not os.path.exists(FAVORITES_PATH):
        save_favorites([])

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("启名 · AI 起名 服务已启动")
    print("  本机访问:  http://127.0.0.1:%d" % args.port)
    if args.host not in ("127.0.0.1", "localhost"):
        print("  局域网访问: http://<本机IP>:%d （手机同 Wi-Fi 可用）" % args.port)
    print("  数据目录:  %s" % DATA_DIR)
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
