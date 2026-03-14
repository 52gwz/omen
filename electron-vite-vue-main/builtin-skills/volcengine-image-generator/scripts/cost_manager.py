"""成本管理模块

提供缓存、成本估算、质量级别管理等功能。
"""

import hashlib
import json
from pathlib import Path
from typing import Optional

CACHE_DIR = Path.home() / ".volcengine" / "image_cache"

QUALITY_CONFIGS = {
    "image": {
        "preview":  {"size": "512x512"},
        "standard": {"size": "1024x1024"},
        "hd":       {"size": "2048x2048"},
        "4k":       {"size": "4096x4096"},
    },
}

COST_TABLE = {
    "image": {
        "seedream_v40":  {"preview": 0.02, "standard": 0.04, "hd": 0.08, "4k": 0.16},
        "seedream_v45":  {"preview": 0.03, "standard": 0.06, "hd": 0.12, "4k": 0.24},
        "general_v30":   {"preview": 0.02, "standard": 0.04, "hd": 0.08, "4k": 0.16},
        "jimeng_v30":    {"preview": 0.02, "standard": 0.04, "hd": 0.08, "4k": 0.16},
        "jimeng_v31":    {"preview": 0.02, "standard": 0.04, "hd": 0.08, "4k": 0.16},
    },
}


class CostManager:

    def __init__(self):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # ── 质量级别 ──────────────────────────────────────────

    @staticmethod
    def get_quality_size(media_type: str, quality: str) -> Optional[str]:
        cfg = QUALITY_CONFIGS.get(media_type, {}).get(quality)
        return cfg["size"] if cfg else None

    # ── 成本估算 ──────────────────────────────────────────

    @staticmethod
    def estimate_cost(media_type: str, model: str, quality: str,
                      duration: int = None) -> dict:
        base = COST_TABLE.get(media_type, {}).get(model, {}).get(quality, 0)
        if media_type == "video" and duration:
            base = base * (duration / 5)
        return {"estimated_cost": round(base, 4), "currency": "CNY"}

    # ── 缓存管理 ──────────────────────────────────────────

    @staticmethod
    def _cache_key(prompt: str, model: str, **kwargs) -> str:
        content = f"{prompt}|{model}"
        for k in sorted(kwargs.keys()):
            if kwargs[k] is not None:
                content += f"|{k}={kwargs[k]}"
        return hashlib.md5(content.encode()).hexdigest()[:16]

    def find_cache(self, prompt: str, model: str, **kwargs) -> Optional[dict]:
        key = self._cache_key(prompt, model, **kwargs)
        path = CACHE_DIR / f"{key}.json"
        if path.exists():
            with open(path) as f:
                return json.load(f)

        return self._find_similar(prompt, model)

    def _find_similar(self, prompt: str, model: str,
                      threshold: float = 0.85) -> Optional[dict]:
        prompt_words = set(prompt.lower().split())
        if not prompt_words:
            return None

        for cache_file in CACHE_DIR.glob("*.json"):
            try:
                with open(cache_file) as f:
                    data = json.load(f)
                cached_prompt = data.get("prompt", "")
                cached_model = data.get("model", "")
                if cached_model != model:
                    continue
                cached_words = set(cached_prompt.lower().split())
                union = prompt_words | cached_words
                if not union:
                    continue
                similarity = len(prompt_words & cached_words) / len(union)
                if similarity >= threshold:
                    return data.get("result")
            except (json.JSONDecodeError, KeyError):
                continue
        return None

    def save_cache(self, prompt: str, model: str, result: dict, **kwargs):
        key = self._cache_key(prompt, model, **kwargs)
        data = {"prompt": prompt, "model": model, "result": result, "params": kwargs}
        with open(CACHE_DIR / f"{key}.json", "w") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def clear_cache(self):
        count = 0
        for f in CACHE_DIR.glob("*.json"):
            f.unlink()
            count += 1
        print(f"✅ 已清理 {count} 个缓存文件")
