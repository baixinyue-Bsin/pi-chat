"""绘制图1：附件1中100条样本的三模态输入统计。"""
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


CSV_PATH = Path("/Users/betty/Desktop/HuaweiCupProblemE/submission/q1_features/summary_100.csv")
PNG_PATH = Path("/Users/betty/Desktop/HuaweiCupProblemE/outputs/figs/q1_input_stats.png")
PDF_PATH = Path("/Users/betty/Desktop/HuaweiCupProblemE/paper/figures/q1_input_stats.pdf")

BLUE, GREEN, ORANGE = "#2a78d6", "#1baf7a", "#eb6834"
RED, GRAY, GRID = "#e34948", "#8a8984", "#e6e5e1"


def summary(values):
    return {
        "n": len(values), "min": values.min(), "max": values.max(),
        "mean": values.mean(), "median": values.median(),
    }


def style_axis(ax):
    ax.set_axisbelow(True)
    ax.grid(axis="y", color=GRID, linewidth=0.7)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_linewidth(0.8)
    ax.spines["bottom"].set_linewidth(0.8)
    ax.tick_params(labelsize=9)


def main():
    df = pd.read_csv(CSV_PATH)
    required = ["video_duration_s", "n_words", "n_tokens_full", "valid_len", "truncated"]
    missing = set(required) - set(df.columns)
    if missing:
        raise ValueError(f"CSV 缺少字段：{sorted(missing)}")

    # 兼容 CSV 中布尔值可能被保存为字符串的情形。
    truncated = df["truncated"].astype(str).str.strip().str.lower().isin(["true", "1", "yes"])
    duration, words, tokens = (df[c].astype(float) for c in
                               ["video_duration_s", "n_words", "n_tokens_full"])
    ds, ws, ts = summary(duration), summary(words), summary(tokens)
    over_48 = int((tokens > 48).sum())
    trunc_n = int(truncated.sum())

    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.sans-serif": ["SimSun", "Songti SC", "STSong", "Microsoft YaHei", "DejaVu Sans"],
        "font.size": 10.5,
        "font.weight": "normal",
        "axes.titlesize": 10.5,
        "axes.titleweight": "normal",
        "axes.labelsize": 10.5,
        "axes.labelweight": "normal",
        "xtick.labelsize": 10.5,
        "ytick.labelsize": 10.5,
        "legend.fontsize": 10.5,
        "axes.unicode_minus": False,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })
    # 图名由论文 caption 提供，图内不再重复放置总标题，以优先保证版式清晰。
    fig, axes = plt.subplots(1, 3, figsize=(14, 4.2), dpi=300)
    fig.subplots_adjust(left=0.06, right=0.98, bottom=0.18, top=0.88, wspace=0.35)

    # (a) 视频时长
    ax = axes[0]
    ax.hist(duration, bins=12, color=BLUE, edgecolor="white", linewidth=0.8, alpha=0.90)
    ax.axvline(ds["median"], color=GRAY, linestyle="--", linewidth=1.25, label="中位数")
    ax.set(xlabel="视频时长 / s", ylabel="样本数")
    ax.set_title("(a) 视频时长分布", pad=12, fontweight="normal")
    style_axis(ax)

    # (b) 原文词数
    ax = axes[1]
    ax.hist(words, bins=12, color=GREEN, edgecolor="white", linewidth=0.8, alpha=0.90)
    ax.axvline(ws["median"], color=GRAY, linestyle="--", linewidth=1.25, label="中位数")
    ax.set(xlabel="原文词数", ylabel="样本数")
    ax.set_title("(b) 原文词数分布", pad=12, fontweight="normal")
    style_axis(ax)

    # (c) 完整 BERT 词元数及截断标识
    ax = axes[2]
    counts, _, _ = ax.hist(tokens, bins=12, color=ORANGE, edgecolor="white", linewidth=0.8, alpha=0.90)
    ax.axvline(48, color=RED, linestyle="--", linewidth=1.35, label="48词元截断线")
    ax.axvline(50, color=GRAY, linestyle="-.", linewidth=1.25, label="50位置上限")
    rug_y = -max(counts) * 0.06
    ax.scatter(tokens[truncated], np.full(trunc_n, rug_y), marker="^", s=28,
               color=RED, edgecolors="white", linewidths=0.35, clip_on=False,
               zorder=4, label="截断样本")
    ax.set_ylim(-2, max(counts) * 1.18)
    # 右侧留出图内图例空间，避免覆盖 x=48、50 的阈值线及数据柱。
    ax.set_xlim(tokens.min() - 1, 100)
    ax.set(xlabel="BERT 词元数", ylabel="样本数")
    ax.set_title("(c) BERT词元数分布与截断线", pad=12, fontweight="normal")
    style_axis(ax)
    # 图例置于 (c) 内部右上角，利用右侧留白且不遮挡阈值线或柱形图。
    ax.legend(loc="upper right", bbox_to_anchor=(0.98, 0.98), ncol=1,
              frameon=True, facecolor="white", edgecolor="#d9d9d9",
              framealpha=0.90, fontsize=10.5, handlelength=2.2,
              borderpad=0.4, labelspacing=0.4)

    PNG_PATH.parent.mkdir(parents=True, exist_ok=True)
    PDF_PATH.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(PNG_PATH, dpi=300, bbox_inches="tight", facecolor="white")
    fig.savefig(PDF_PATH, dpi=300, bbox_inches="tight", facecolor="white")
    plt.close(fig)

    print("统计摘要")
    print(f"样本总数：{len(df)}")
    print(f"视频时长：{ds['min']:.3f}–{ds['max']:.3f} s，均值 {ds['mean']:.3f} s，中位数 {ds['median']:.4f} s")
    print(f"原文词数：{ws['min']:.0f}–{ws['max']:.0f}，均值 {ws['mean']:.2f}，中位数 {ws['median']:.0f}")
    print(f"BERT词元数：{ts['min']:.0f}–{ts['max']:.0f}，均值 {ts['mean']:.2f}，中位数 {ts['median']:.0f}")
    print(f"超过48个词元：{over_48} 条；截断样本：{trunc_n} 条；valid_len 最大值：{df['valid_len'].max()}")
    print(f"已保存 PNG：{PNG_PATH}")
    print(f"已保存 PDF：{PDF_PATH}")


if __name__ == "__main__":
    main()
