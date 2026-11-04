# 本地 OCR 小工具（RapidOCR / onnxruntime，纯本地、不联网）
#
# 为什么用它：她（文本模型）看九宫格时，缩到 480px 的画面里小字会糊；
#   OCR 在**原生分辨率**上把字读出来，只把文字给她 —— 又准又省 token ✓
#
# 用法：python ocr.py <图片1> <图片2> ...
# 输出：JSON 数组 [{ "file": "...", "lines": [{"text": "...", "score": 0.98}, ...] }]
#      失败时返回空 lines（单张失败不该让整批失败）
import json
import sys

# 2026-11-04：Windows 上 python 的 stdout 默认是 GBK → 中文 JSON 到 node 那边全是乱码 ✗
#   强制 UTF-8 输出（node 侧按 utf8 读），否则识别结果等于白做 ✓
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

def main() -> int:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"rapidocr 没装好：{exc}"}, ensure_ascii=False))
        return 3

    try:
        engine = RapidOCR()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"RapidOCR 初始化失败：{exc}"}, ensure_ascii=False))
        return 4

    out = []
    for path in sys.argv[1:]:
        lines = []
        try:
            result, _elapse = engine(path)
            for item in (result or []):
                # item = [box, text, score]
                if len(item) < 3:
                    continue
                text = str(item[1]).strip()
                if not text:
                    continue
                try:
                    score = float(item[2])
                except Exception:  # noqa: BLE001
                    score = 0.0
                box = item[0]
                try:
                    xs = [float(pt[0]) for pt in box]
                    ys = [float(pt[1]) for pt in box]
                    rect = {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)}
                except Exception:  # noqa: BLE001
                    rect = None
                lines.append({"text": text, "score": score, "box": rect})
        except Exception:  # noqa: BLE001
            lines = []
        out.append({"file": path, "lines": lines})

    print(json.dumps(out, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
