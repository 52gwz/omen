#!/usr/bin/env python3
"""火山引擎豆包文生图 - 主生成脚本

支持方舟 API（Seedream 4.0/4.5/5.0）和视觉 API（通用3.0、即梦3.0/3.1）。
"""

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

import requests

from cost_manager import CostManager
from volcano_signer import VolcSigner

# ── 模型配置 ──────────────────────────────────────────────

MODEL_CONFIGS = {
    "seedream_v40": {
        "api_type": "ark",
        "model_id": "doubao-seedream-4-0-250828",
        "description": "Seedream 4.0，组图生成、多模态输入、图像编辑",
        "supports": ["t2i", "i2i", "edit", "multi_image"],
    },
    "seedream_v45": {
        "api_type": "ark",
        "model_id": "doubao-seedream-4-5-251128",
        "description": "Seedream 4.5，效果优秀，支持4K",
        "supports": ["t2i", "i2i", "edit", "multi_image"],
    },
    "seedream_v50": {
        "api_type": "ark",
        "model_id": "doubao-seedream-5-0-260128",
        "description": "Seedream 5.0，最新版本，跨模态理解增强、精准指令遵循、联网检索",
        "supports": ["t2i", "i2i", "edit", "multi_image"],
    },
    "general_v30": {
        "api_type": "visual",
        "req_key": "high_aes_general_v30l_zt2i",
        "description": "通用3.0，高清大图、逼真人像、文字响应",
        "sync": True,
    },
    "jimeng_v30": {
        "api_type": "visual",
        "req_key": "jimeng_t2i_v30",
        "description": "即梦3.0，即梦同源、文字排版、层次美感",
        "sync": False,
    },
    "jimeng_v31": {
        "api_type": "visual",
        "req_key": "jimeng_t2i_v31",
        "description": "即梦3.1，画面美感升级、风格多样",
        "sync": False,
    },
}

RATIO_SIZES = {
    "1:1": "1024x1024",
    "4:3": "1024x768",
    "16:9": "1024x576",
    "9:16": "576x1024",
    "21:9": "1024x439",
}

PRESET_SIZES = {
    "2K": "2048x2048",
    "4K": "4096x4096",
}

ARK_API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
VISUAL_API_HOST = "visual.volcengineapi.com"


# ── 认证 ──────────────────────────────────────────────────

def load_config() -> dict:
    config_path = Path.home() / ".volcengine" / "config.json"
    if config_path.exists():
        with open(config_path) as f:
            return json.load(f)
    return {}


def get_ark_api_key() -> str:
    key = os.environ.get("ARK_API_KEY")
    if not key:
        key = load_config().get("ark_api_key")
    if not key:
        print("错误: 未找到 ARK_API_KEY。请设置环境变量或配置 ~/.volcengine/config.json")
        sys.exit(1)
    return key


def get_volc_credentials() -> tuple[str, str]:
    ak = os.environ.get("VOLC_ACCESS_KEY") or load_config().get("access_key")
    sk = os.environ.get("VOLC_SECRET_KEY") or load_config().get("secret_key")
    if not ak or not sk:
        print("错误: 未找到 VOLC_ACCESS_KEY/VOLC_SECRET_KEY。请设置环境变量或配置 ~/.volcengine/config.json")
        sys.exit(1)
    return ak, sk


# ── 方舟 API 生成 ────────────────────────────────────────

def generate_image_ark(prompt: str, model: str, size: str = "1024x1024",
                       seed: int = None, reference_images: list = None,
                       watermark: bool = False) -> dict:
    api_key = get_ark_api_key()
    model_config = MODEL_CONFIGS[model]

    body = {
        "model": model_config["model_id"],
        "prompt": prompt,
        "size": size,
        "response_format": "url",
        "watermark": watermark,
    }
    if seed is not None:
        body["seed"] = seed
    if reference_images:
        body["reference_images"] = [{"url": url} for url in reference_images]

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    response = requests.post(ARK_API_URL, headers=headers, json=body, timeout=120)
    try:
        response.raise_for_status()
    except requests.HTTPError as e:
        print(f"API 错误响应: {response.text}")
        raise
    return response.json()


# ── 视觉 API 生成 ────────────────────────────────────────

def generate_image_visual_sync(prompt: str, model: str, width: int = 1024,
                               height: int = 1024, seed: int = -1,
                               use_pre_llm: bool = False, scale: float = 2.5,
                               watermark: bool = False) -> dict:
    """同步模式（通用3.0）"""
    ak, sk = get_volc_credentials()
    model_config = MODEL_CONFIGS[model]

    body = {
        "req_key": model_config["req_key"],
        "prompt": prompt,
        "width": width,
        "height": height,
        "seed": seed,
        "use_pre_llm": use_pre_llm,
        "scale": scale,
        "return_url": True,
    }
    if watermark:
        body["logo_info"] = {"add_logo": True}

    url = f"https://{VISUAL_API_HOST}/2022-08-31/cv/process"
    signer = VolcSigner(ak, sk)
    headers = signer.sign("POST", url, body)

    response = requests.post(url, headers=headers, json=body, timeout=120)
    response.raise_for_status()
    return response.json()


def generate_image_visual_async(prompt: str, model: str, width: int = 1024,
                                height: int = 1024, seed: int = -1,
                                use_pre_llm: bool = False, scale: float = 2.5,
                                watermark: bool = False) -> dict:
    """异步模式（即梦3.0/3.1）：提交任务 → 轮询结果"""
    ak, sk = get_volc_credentials()
    model_config = MODEL_CONFIGS[model]

    body = {
        "req_key": model_config["req_key"],
        "prompt": prompt,
        "width": width,
        "height": height,
        "seed": seed,
        "use_pre_llm": use_pre_llm,
        "scale": scale,
        "return_url": True,
    }
    if watermark:
        body["logo_info"] = {"add_logo": True}

    submit_url = f"https://{VISUAL_API_HOST}/2022-08-31/cv/process"
    signer = VolcSigner(ak, sk)
    headers = signer.sign("POST", submit_url, body)
    response = requests.post(submit_url, headers=headers, json=body, timeout=30)
    response.raise_for_status()
    result = response.json()

    task_id = result.get("data", {}).get("task_id")
    if not task_id:
        return result

    query_url = f"https://{VISUAL_API_HOST}/2022-08-31/cv/process"
    for i in range(60):
        time.sleep(3)
        query_body = {"req_key": model_config["req_key"], "task_id": task_id}
        headers = signer.sign("POST", query_url, query_body)
        resp = requests.post(query_url, headers=headers, json=query_body, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        status = data.get("data", {}).get("status")
        if status == "done":
            return data
        if status == "failed":
            raise RuntimeError(f"任务失败: {data}")

    raise TimeoutError("视觉 API 异步任务超时（180秒）")


# ── 统一入口 + 重试 ──────────────────────────────────────

def generate_with_retry(prompt: str, model: str, size: str = "1024x1024",
                        max_retries: int = 3, **kwargs) -> dict:
    model_config = MODEL_CONFIGS[model]
    width, height = map(int, size.split("x"))

    for attempt in range(max_retries):
        try:
            if model_config["api_type"] == "ark":
                # 方舟API只支持这些参数，过滤掉视觉API特有的参数
                ark_kwargs = {k: v for k, v in kwargs.items() 
                             if k in ['seed', 'reference_images', 'watermark']}
                return generate_image_ark(prompt, model, size=size, **ark_kwargs)
            elif model_config.get("sync"):
                return generate_image_visual_sync(
                    prompt, model, width=width, height=height, **kwargs
                )
            else:
                return generate_image_visual_async(
                    prompt, model, width=width, height=height, **kwargs
                )
        except requests.Timeout:
            if attempt < max_retries - 1:
                wait = 2 ** attempt
                print(f"⏳ 请求超时，{wait}秒后重试（{attempt + 1}/{max_retries}）...")
                time.sleep(wait)
                continue
            raise
        except requests.HTTPError as e:
            if e.response is not None and e.response.status_code == 429:
                wait = min(60, 2 ** (attempt + 3))
                print(f"⏳ 触发限流，{wait}秒后重试...")
                time.sleep(wait)
                continue
            raise


def download_image(url: str, output_path: str):
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(resp.content)
    print(f"✅ 图片已保存到 {output_path}")


def save_base64_image(b64_data: str, output_path: str):
    with open(output_path, "wb") as f:
        f.write(base64.b64decode(b64_data))
    print(f"✅ 图片已保存到 {output_path}")


def extract_and_save(result: dict, model: str, output_path: str):
    model_config = MODEL_CONFIGS[model]

    if model_config["api_type"] == "ark":
        data_list = result.get("data", [])
        if data_list:
            url = data_list[0].get("url")
            if url:
                download_image(url, output_path)
                return
            b64 = data_list[0].get("b64_json")
            if b64:
                save_base64_image(b64, output_path)
                return
    else:
        image_urls = result.get("data", {}).get("image_urls", [])
        if image_urls:
            download_image(image_urls[0], output_path)
            return
        binary_data = result.get("data", {}).get("binary_data_base64", [])
        if binary_data:
            save_base64_image(binary_data[0], output_path)
            return

    print("⚠️ 未能从返回结果中提取图片")
    print(json.dumps(result, indent=2, ensure_ascii=False))


# ── 风格模板 ─────────────────────────────────────────────

STYLES_DIR = Path.home() / ".volcengine" / "image_styles"


def save_style(name: str, args: argparse.Namespace):
    STYLES_DIR.mkdir(parents=True, exist_ok=True)
    style = {
        "model": args.model,
        "size": args.size,
        "ratio": args.ratio,
        "quality": args.quality,
        "seed": args.seed,
        "watermark": args.watermark,
        "use_pre_llm": args.use_pre_llm,
        "scale": args.scale,
    }
    with open(STYLES_DIR / f"{name}.json", "w") as f:
        json.dump(style, f, indent=2, ensure_ascii=False)
    print(f"✅ 风格模板 '{name}' 已保存")


def load_style(name: str) -> dict:
    path = STYLES_DIR / f"{name}.json"
    if not path.exists():
        print(f"错误: 风格模板 '{name}' 不存在")
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def list_styles():
    if not STYLES_DIR.exists():
        print("暂无风格模板")
        return
    styles = list(STYLES_DIR.glob("*.json"))
    if not styles:
        print("暂无风格模板")
        return
    print("📋 已保存的风格模板：")
    for s in styles:
        with open(s) as f:
            data = json.load(f)
        print(f"  - {s.stem}  (model={data.get('model')}, quality={data.get('quality')})")


def delete_style(name: str):
    path = STYLES_DIR / f"{name}.json"
    if path.exists():
        path.unlink()
        print(f"✅ 风格模板 '{name}' 已删除")
    else:
        print(f"风格模板 '{name}' 不存在")


# ── 批量生成 ─────────────────────────────────────────────

def batch_generate(prompts_file: str, output_dir: str, args: argparse.Namespace):
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    with open(prompts_file) as f:
        prompts = [line.strip() for line in f if line.strip()]

    print(f"📦 批量生成 {len(prompts)} 张图片...")
    cost_mgr = CostManager()
    for i, prompt in enumerate(prompts, 1):
        print(f"\n[{i}/{len(prompts)}] {prompt}")
        cached = cost_mgr.find_cache(prompt, args.model)
        if cached and not args.no_cache:
            print("  ↳ 使用缓存结果")
            extract_and_save(cached, args.model, str(output_path / f"{i:03d}.png"))
            continue

        size = resolve_size(args)
        result = generate_with_retry(
            prompt, args.model, size=size,
            seed=args.seed, watermark=args.watermark,
            use_pre_llm=args.use_pre_llm, scale=args.scale,
        )
        cost_mgr.save_cache(prompt, args.model, result, size=size)
        extract_and_save(result, args.model, str(output_path / f"{i:03d}.png"))

    print(f"\n✅ 批量生成完成，输出目录：{output_dir}")


# ── 尺寸解析 ─────────────────────────────────────────────

def resolve_size(args: argparse.Namespace) -> str:
    cm = CostManager()
    quality_size = cm.get_quality_size("image", args.quality)
    if quality_size and args.quality != "standard":
        return quality_size

    if args.ratio and args.ratio in RATIO_SIZES:
        return RATIO_SIZES[args.ratio]
    if args.size:
        if args.size in PRESET_SIZES:
            return PRESET_SIZES[args.size]
        if "x" in args.size:
            return args.size
    return "1024x1024"


# ── CLI ──────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="火山引擎豆包文生图")

    p.add_argument("--prompt", "-p", help="图像描述提示词")
    p.add_argument("--output", "-o", default="output.png", help="输出文件路径")
    p.add_argument("--model", "-m", default="seedream_v40",
                   choices=list(MODEL_CONFIGS.keys()), help="生成模型")
    p.add_argument("--size", "-s", help="图像尺寸（如 1024x1024、2K、4K）")
    p.add_argument("--ratio", "-r", choices=list(RATIO_SIZES.keys()), help="预设比例")
    p.add_argument("--seed", type=int, help="随机种子")
    p.add_argument("--reference-images", nargs="+", help="参考图片 URL 列表")
    p.add_argument("--watermark", action="store_true", help="添加水印")
    p.add_argument("--use-pre-llm", action="store_true", help="开启文本扩写（视觉 API）")
    p.add_argument("--scale", type=float, default=2.5, help="文本影响程度 1-10（视觉 API）")

    cost = p.add_argument_group("成本管理")
    cost.add_argument("--preview", action="store_true", help="预览模式（低分辨率）")
    cost.add_argument("--quality", "-q", default="standard",
                      choices=["preview", "standard", "hd", "4k"], help="质量级别")
    cost.add_argument("--no-cache", action="store_true", help="禁用缓存")
    cost.add_argument("--estimate-cost", action="store_true", help="仅估算成本")
    cost.add_argument("--clear-cache", action="store_true", help="清理缓存")

    style = p.add_argument_group("风格模板")
    style.add_argument("--save-style", metavar="NAME", help="保存为风格模板")
    style.add_argument("--style", metavar="NAME", help="使用风格模板")
    style.add_argument("--list-styles", action="store_true", help="列出所有风格模板")
    style.add_argument("--delete-style", metavar="NAME", help="删除风格模板")

    batch = p.add_argument_group("批量生成")
    batch.add_argument("--batch", metavar="FILE", help="批量生成提示词文件")
    batch.add_argument("--output-dir", metavar="DIR", help="批量输出目录")

    p.add_argument("--list-models", action="store_true", help="列出所有可用模型")
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()

    if args.list_models:
        print("📋 可用模型：")
        for name, cfg in MODEL_CONFIGS.items():
            api = cfg["api_type"]
            mid = cfg.get("model_id") or cfg.get("req_key")
            print(f"  {name:20s}  [{api}]  {mid}")
            print(f"  {'':20s}  {cfg['description']}")
        return

    if args.list_styles:
        list_styles()
        return

    if args.delete_style:
        delete_style(args.delete_style)
        return

    if args.clear_cache:
        CostManager().clear_cache()
        return

    if args.preview:
        args.quality = "preview"

    if args.style:
        style_data = load_style(args.style)
        for k, v in style_data.items():
            if v is not None and getattr(args, k, None) in (None, False, "standard", "seedream_v40"):
                setattr(args, k, v)

    if args.save_style:
        if not args.prompt:
            print("错误: 保存风格模板时需要提供 --prompt 参数以确定配置")
            sys.exit(1)
        save_style(args.save_style, args)
        return

    if args.batch:
        if not args.output_dir:
            args.output_dir = "./batch_output"
        batch_generate(args.batch, args.output_dir, args)
        return

    if not args.prompt:
        parser.print_help()
        sys.exit(1)

    cost_mgr = CostManager()
    size = resolve_size(args)

    if args.estimate_cost:
        est = cost_mgr.estimate_cost("image", args.model, args.quality)
        print("💰 成本估算")
        print(f"  模型: {args.model}")
        print(f"  质量: {args.quality}")
        print(f"  尺寸: {size}")
        print(f"  预估费用: ¥{est['estimated_cost']}")
        print("  实际价格以火山引擎官方定价为准")
        return

    if not args.no_cache:
        cached = cost_mgr.find_cache(args.prompt, args.model)
        if cached:
            print("✅ 使用缓存结果")
            extract_and_save(cached, args.model, args.output)
            return

    print(f"🎨 正在生成图像...")
    print(f"  模型: {args.model}")
    print(f"  尺寸: {size}")
    print(f"  提示词: {args.prompt[:80]}{'...' if len(args.prompt) > 80 else ''}")

    result = generate_with_retry(
        args.prompt, args.model, size=size,
        seed=args.seed,
        reference_images=args.reference_images,
        watermark=args.watermark,
        use_pre_llm=args.use_pre_llm,
        scale=args.scale,
    )

    cost_mgr.save_cache(args.prompt, args.model, result, size=size)
    extract_and_save(result, args.model, args.output)


if __name__ == "__main__":
    main()
