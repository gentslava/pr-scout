"""LLM providers for text jobs (writing missing PR descriptions).

Two kinds, which covers practically every provider there is:

* `ollama` — a local Ollama through its native API, which (unlike its OpenAI-compatible one)
  lets us set the context window: a 24k-character diff does not fit the default.
* `openai` — any OpenAI-compatible chat endpoint: NordRouter, OpenRouter, OpenAI, vLLM,
  LM Studio, DeepSeek, Groq, a company gateway... Built-in presets only need a key; any
  other endpoint is configuration, not code:

      LLM_API_URL=https://api.example.com/v1   LLM_API_KEY=...   LLM_API_NAME=Example
      LLM_PROVIDERS=[{"id": "vllm", "name": "vLLM", "url": "http://gpu:8000/v1"}, ...]

  A provider in LLM_PROVIDERS takes `key` (or `key_env`, the variable holding it, when that
  variable reaches the container), an optional default `model` and extra `headers`.

Jev is not here: it is a typed evaluation API, not a chat model (see main.py).
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request


def _env(name, default=""):
    return os.environ.get(name) or default


# id -> provider; `key_env` names the variable with the key, `model` is the default model.
BUILTIN = [
    {"id": "ollama", "name": "Ollama", "kind": "ollama", "url": _env("OLLAMA_URL", "http://host.docker.internal:11434").rstrip("/"),
     "local": True, "model": "qwen3.5:9b"},
    # NORDROUTER_URL predates this module and is the site root, without /v1
    {"id": "nordrouter", "name": "NordRouter", "kind": "openai", "url": _env("NORDROUTER_URL", "https://nordrouter.com").rstrip("/") + "/v1",
     "key_env": "NORDROUTER_API_KEY", "model": _env("DESCRIBER_MODEL", "google/gemini-3.1-flash-lite")},
    {"id": "openrouter", "name": "OpenRouter", "kind": "openai", "url": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY",
     "headers": {"X-Title": "PR Scout"}},
    {"id": "openai", "name": "OpenAI", "kind": "openai", "url": "https://api.openai.com/v1", "key_env": "OPENAI_API_KEY"},
]


def load_providers():
    """Built-ins, then the LLM_API_URL shortcut, then LLM_PROVIDERS; a later id replaces an earlier one."""
    found = {p["id"]: dict(p) for p in BUILTIN}
    if _env("LLM_API_URL"):
        found["custom"] = {"id": "custom", "name": _env("LLM_API_NAME", "Свой провайдер"), "kind": "openai",
                           "url": _env("LLM_API_URL").rstrip("/"), "key": _env("LLM_API_KEY"), "model": _env("LLM_MODEL")}
    raw = _env("LLM_PROVIDERS")
    if raw:
        try:
            extra = json.loads(raw)
        except ValueError as e:
            print(f"LLM_PROVIDERS is not valid JSON, ignored: {e}", flush=True)
            extra = []
        for p in extra if isinstance(extra, list) else []:
            if not isinstance(p, dict) or not p.get("id") or not p.get("url"):
                print(f"LLM_PROVIDERS entry without id or url, ignored: {p!r}", flush=True)
                continue
            found[str(p["id"])] = {"kind": "openai", "name": p["id"], **p, "url": str(p["url"]).rstrip("/")}
    for p in found.values():
        if "key" not in p:
            p["key"] = _env(p["key_env"]) if p.get("key_env") else ""
    return found


PROVIDERS = load_providers()


def is_ready(p):
    """Usable without further setup: Ollama and keyless endpoints (a local vLLM) need no key."""
    return p["kind"] == "ollama" or bool(p.get("key")) or not p.get("key_env")


def public(p):
    """What the UI may see about a provider: never the key itself."""
    return {"id": p["id"], "name": p["name"], "kind": p["kind"], "local": bool(p.get("local")), "ready": is_ready(p),
            "key_env": p.get("key_env"), "default_model": p.get("model") or ""}


def get(pid):
    p = PROVIDERS.get(pid or "ollama")
    if not p:
        raise RuntimeError(f"Провайдер «{pid}» не настроен на сервере")
    return p


def _headers(p):
    h = {"Content-Type": "application/json", **(p.get("headers") or {})}
    if p.get("key"):
        h["Authorization"] = f"Bearer {p['key']}"
    return h


def _request(url, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


_models_cache: dict[str, tuple[float, list[str]]] = {}
_models_lock = threading.Lock()


def models(pid, ttl=600, fail_ttl=60):
    """Model ids the provider offers, cached for a while: OpenRouter alone lists hundreds.

    A failed lookup is cached too, briefly, so an unreachable host does not stall every
    status request on its timeout.
    """
    p = get(pid)
    with _models_lock:
        hit = _models_cache.get(pid)
        if hit and time.time() - hit[0] < (ttl if hit[1] else fail_ttl):
            return hit[1]
    try:
        if p["kind"] == "ollama":
            names = [m["name"] for m in _request(f"{p['url']}/api/tags", timeout=10)["models"] if "embed" not in m["name"]]
        else:
            names = sorted(m["id"] for m in _request(f"{p['url']}/models", headers=_headers(p), timeout=20).get("data") or [] if m.get("id"))
    except Exception:
        names = []  # unreachable is not an error for a model list: the UI falls back to typing a name
    with _models_lock:
        _models_cache[pid] = (time.time(), names)
    return names


def complete(p, model, prompt, max_tokens=400, temperature=0.2, retry=None):
    """One prompt, one answer: returns (text, output_tokens).

    `retry` wraps the HTTP call for OpenAI-compatible endpoints (rate limits, network blips).
    Newer OpenAI models reject `max_tokens` and a custom temperature; on that 400 the call is
    repeated once in the form they accept, so the same code serves old and new models.
    """
    if p["kind"] == "ollama":
        res = _request(f"{p['url']}/api/generate", {"model": model, "prompt": prompt, "stream": False, "think": False,
                                                    "options": {"num_ctx": 16384, "temperature": temperature}}, {"Content-Type": "application/json"}, 300)
        return res.get("response", "").strip(), res.get("eval_count", 0)
    call = retry or (lambda url, body, headers, timeout: _request(url, body, headers, timeout))
    body = {"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": max_tokens, "temperature": temperature}
    try:
        res = call(f"{p['url']}/chat/completions", body, _headers(p), 180)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore") if e.code == 400 else ""
        if "max_tokens" not in detail and "temperature" not in detail:
            raise RuntimeError(f"{p['name']}: HTTP {e.code} {detail[:200]}".strip()) from e
        body = {"model": model, "messages": body["messages"], "max_completion_tokens": max_tokens}
        res = call(f"{p['url']}/chat/completions", body, _headers(p), 180)
    choice = (res.get("choices") or [{}])[0]
    text = ((choice.get("message") or {}).get("content") or "").strip()
    return text, (res.get("usage") or {}).get("completion_tokens", 0)
