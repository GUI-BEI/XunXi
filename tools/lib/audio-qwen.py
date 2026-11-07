"""Qwen2-Audio 本地推理（给她听懂声音用）

用法：
  python audio-qwen.py <音频1.wav> [<音频2.wav> ...] [--ask "问题"] [--json] [--model 目录]

输出：每个音频一段回答（--json 时是 [{wav, answer}]）
首次加载模型约 20–60 秒；同一进程里处理多个音频只加载一次。
"""
import argparse
import json
import sys

# Windows 上 python 的 stdout 默认 GBK → 中文 JSON 到 node 全是乱码（和 ocr.py 同一个坑）
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

DEFAULT_ASK = (
    "你在听一段音频（不是读文字）。用 3–5 句话回答三件事："
    "①谁在说话、在唱还是单纯出声，内容大意即可（听不清就说听不清，别编）；"
    "②语气/情绪给出**具体**判断（温柔/急躁/敷衍/兴奋/委屈/调侃/严肃/激动/疲倦…），"
    "并说依据（语速快慢、音高高低、音量起伏、停顿多少、有没有气声或笑）；"
    "③有没有唱歌、配乐、音效或其它声音；如果有音乐，说它轻快还是舒缓、是主还是垫。"
    "不要用「中性」敷衍——除非真的听不出起伏。"
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--model", default=r"D:\AIWork\Qwen2-Audio-7B-Instruct")
    ap.add_argument("--ask", default=DEFAULT_ASK)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--max-new-tokens", type=int, default=180)
    args = ap.parse_args()

    try:
        import torch
        from transformers import AutoProcessor, Qwen2AudioForConditionalGeneration
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"依赖不全：{exc}"}, ensure_ascii=False))
        return 3

    try:
        processor = AutoProcessor.from_pretrained(args.model)
        model = Qwen2AudioForConditionalGeneration.from_pretrained(
            args.model,
            torch_dtype=torch.float16,
            load_in_4bit=True,
            device_map="auto",
        )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"模型加载失败：{exc}"}, ensure_ascii=False))
        return 4

    results = []
    for wav in args.wavs:
        try:
            conversation = [
                {
                    "role": "user",
                    "content": [
                        {"type": "audio", "audio_url": wav},
                        {"type": "text", "text": args.ask},
                    ],
                }
            ]
            text = processor.apply_chat_template(conversation, add_generation_prompt=True, tokenize=False)
            # 2026-11-08 踩坑：直接把路径当 audios 传会让 feature_extractor 去 np.asarray(str) 崩掉 ✗
            #   自己用 soundfile 读成 float32 单声道数组再传（audio.mjs 已统一转 16k 单声道）
            import soundfile as sf
            wav_data, sr = sf.read(wav, dtype="float32", always_2d=False)
            if wav_data.ndim > 1:
                wav_data = wav_data.mean(axis=1)
            if sr != 16000:
                raise ValueError(f"采样率必须是 16000，当前 {sr}（先用 ffmpeg 转 16k 单声道）")
            inputs = processor(text=text, audios=[wav_data], return_tensors="pt").to(model.device)
            with torch.no_grad():
                out = model.generate(**inputs, max_new_tokens=args.max_new_tokens)
            prompt_len = inputs["input_ids"].shape[1]
            answer = processor.batch_decode(out[:, prompt_len:], skip_special_tokens=True)[0].strip()
            results.append({"wav": wav, "answer": answer})
        except Exception as exc:  # noqa: BLE001
            results.append({"wav": wav, "error": str(exc)[:300]})

    if args.json:
        print(json.dumps(results, ensure_ascii=False))
    else:
        for r in results:
            print(f"=== {r['wav']} ===")
            print(r.get("answer") or f"(失败：{r.get('error')})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
