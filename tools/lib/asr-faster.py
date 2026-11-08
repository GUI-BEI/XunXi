"""faster-whisper 转写（带词级时间戳与置信度）

用法：python asr-faster.py <wav16k单声道> [--model 目录] [--lang zh] [--json]
输出 JSON：{"language": "zh", "segments": [{"start": 1.2, "end": 3.4, "text": "...", "avg_logprob": -0.31, "no_speech": 0.01, "words": [...]}]}
"""
import argparse
import json
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--model", default=r"D:\AIWork\faster-whisper-large-v3")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--beam", type=int, default=5)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"faster_whisper 不可用：{exc}"}, ensure_ascii=False))
        return 3

    try:
        # 8G 显存：large-v3 用 int8_float16 够稳；没显卡时退 CPU
        try:
            model = WhisperModel(args.model, device="cuda", compute_type="int8_float16")
        except Exception:
            model = WhisperModel(args.model, device="cpu", compute_type="int8")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"模型加载失败：{exc}"}, ensure_ascii=False))
        return 4

    try:
        # 2026-11-08：环境声（风声/雨声/脚步）会被硬转成字 —— 这是幻觉，不是信息。
        #   三道闸：VAD 先掐掉非语音段 + no_speech_prob 阈值 + avg_logprob 阈值
        segments, info = model.transcribe(
            args.wav,
            language=args.lang,
            beam_size=args.beam,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "threshold": 0.5},
            no_speech_threshold=0.6,
            log_prob_threshold=-0.8,
            condition_on_previous_text=False,
            word_timestamps=True,
        )
        out = []
        for s in segments:
            words = [{"w": w.word, "start": round(w.start, 2), "end": round(w.end, 2), "p": round(w.probability, 3)} for w in (s.words or [])]
            out.append(
                {
                    "start": round(s.start, 2),
                    "end": round(s.end, 2),
                    "text": (s.text or "").strip(),
                    "avg_logprob": round(getattr(s, "avg_logprob", 0.0) or 0.0, 3),
                    "no_speech": round(getattr(s, "no_speech_prob", 0.0) or 0.0, 3),
                    "words": words,
                }
            )
        result = {"language": getattr(info, "language", args.lang), "duration": round(getattr(info, "duration", 0.0), 1), "segments": out}
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"转写失败：{exc}"}, ensure_ascii=False))
        return 5

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for s in result["segments"]:
            print(f"[{s['start']:.1f}-{s['end']:.1f}] ({s['avg_logprob']}) {s['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
