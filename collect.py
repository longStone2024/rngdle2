#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RNG Room 收集模式人性化 AI 服务器

核心设计：
  * 默认 mode=collect, human_mode=True, skill=0.25
  * 油猴只传 {n, k} 和 {game_id, x}，全部走默认参数
  * 人类认知分两条通道：
      - 通道 A（模式识别）：67 / 69 / 911 / 007 / 404 这类字符串，
        人类一眼认出，噪声低但带情绪偏置
      - 通道 B（数值计算）：prime / square / power-of-* 等，
        人类 4 秒内算不出来，噪声极高
  * 并发锁 + 1.5s 幂等窗口
  * 跨局累积样本，持久化到 observed.json.gz
"""

import argparse
import gzip
import json
import math
import os
import random
import sys
import tempfile
import threading
import time
import uuid
from array import array
from bisect import bisect_left
from collections import Counter

from flask import Flask, jsonify, render_template, request

MAX_N = 1_000_000
TABLE_LEN = MAX_N + 1
EXPECTED_BYTES = TABLE_LEN * 4
GAME_LEN = 30
MAX_PICKS = 5
MIN_SAMPLES_FOR_DP = 30
SESSION_TTL = 2 * 3600
IDEMPOTENT_WINDOW = 1.5      # 秒

# 默认行为：油猴不改也能享用
DEFAULT_MODE = "collect"
DEFAULT_HUMAN_MODE = True
DEFAULT_SKILL = 0.35

app = Flask(__name__)
TABLE = None

OBSERVED = {}
SAMPLES_PATH = "observed.json.gz"

# 内部网页游戏的状态（沿用原有 DP 策略，不受 human_mode 影响）
STATE = {
    "phase": "idle", "xs": [], "turn": 0,
    "ai_score": 0, "human_score": 0,
    "ai_picks": 0, "human_picks": 0,
    "rounds": [], "thresholds": None,
}

SESSIONS = {}


# ============================================================
# 表加载
# ============================================================
def load_table(path):
    with gzip.open(path, "rb") as f:
        raw = f.read()
    if len(raw) != EXPECTED_BYTES:
        raise ValueError(
            f"{path}: {len(raw)} bytes after gunzip, expected {EXPECTED_BYTES}"
        )
    t = array("I", raw)
    if t.itemsize != 4:
        raise RuntimeError("array('I') is not 4 bytes on this platform")
    if sys.byteorder == "big":
        t.byteswap()
    return t


# ============================================================
# 样本持久化
# ============================================================
def load_samples(path=SAMPLES_PATH):
    if not os.path.exists(path):
        return {}
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            data = json.load(f)
        return {int(k): int(v) for k, v in data.get("samples", {}).items()}
    except Exception as e:
        print(f"[warn] load samples failed: {e}", file=sys.stderr)
        return {}


def save_samples(observed, path=SAMPLES_PATH):
    directory = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    os.close(fd)
    try:
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump({
                "version": 1,
                "count": len(observed),
                "samples": {str(k): int(v) for k, v in observed.items()},
            }, f)
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# ============================================================
# 人类认知模型
# ============================================================

# 通道 A：人类一眼认出、且带情绪价值的字符串
SPECIAL_STRINGS = {
    "007": 1.35,
    "1337": 1.25,
    "911": 1.25,
    "69": 1.20,
    "666": 1.20,
    "8008": 1.15,
    "67": 1.15,
    "404": 1.15,
    "888": 1.15,
    "777": 1.15,
    "420": 1.10,
    "314": 1.10,
    "58008": 1.10,
    "123": 1.10,
    "321": 1.10,
    "100": 1.10,
}

# 通道 B：人类 4 秒内几乎算不出来的数值性质
HEAVY_NUMERIC = {
    "prime", "square", "cube", "power-of-two", "power-of-three",
    "power-of-five", "power-of-seven", "fibonacci", "factorial",
    "fourth-power", "fifth-power", "harshad", "spy", "pronic",
}


def _is_staircase(s):
    if len(s) < 3:
        return False
    up = down = True
    for i in range(1, len(s)):
        a, b = int(s[i - 1]), int(s[i])
        if a == b:
            return False
        if a > b:
            up = False
        if a < b:
            down = False
    return up or down


def human_uncertainty(x):
    """
    0~1 的"字符串结构不确定度"。
    位少、重复多、阶梯、回文、整齐结尾 → 低；位多且杂乱 → 高。
    """
    s = str(x)
    n = len(s)
    dc = Counter(s)
    max_rep = max(dc.values())

    if n <= 3:
        conf = 0.85
    elif n == 4:
        conf = 0.70
    elif n == 5:
        conf = 0.55
    else:
        conf = 0.40

    if max_rep == n:
        conf = min(1.0, conf + 0.45)
    elif max_rep >= 4:
        conf = min(1.0, conf + 0.25)
    elif max_rep >= 3:
        conf = min(1.0, conf + 0.10)

    if _is_staircase(s) or s == s[::-1]:
        conf = min(1.0, conf + 0.15)

    if s[0] in "19" and all(c == "0" for c in s[1:]):
        conf = min(1.0, conf + 0.25)
    if s[0] == "9" and all(c == "9" for c in s[1:]):
        conf = min(1.0, conf + 0.25)
    if s.endswith("000"):
        conf = min(1.0, conf + 0.10)

    return 1.0 - conf


def _special_bias(x):
    """通道 A 的情绪偏置系数。1.0 表示无偏置。最长匹配优先。"""
    s = str(x)
    for key in sorted(SPECIAL_STRINGS, key=len, reverse=True):
        if key in s:
            return SPECIAL_STRINGS[key]
    return 1.0


def perceived_ep(x, true_ep, skill=0.25, property_id=None, memory_blur=1.0):
    """
    人类对 x 的 EP 主观感知。

    参数：
      skill        : 0=完全瞎, 1=接近精确
      property_id  : 可选，rngdle 的性质 id。属于 HEAVY_NUMERIC 时强制拉高噪声
      memory_blur  : 记忆模糊系数。>1 表示回忆已存数字时更模糊

    返回：非负浮点。
    """
    unc = human_uncertainty(x)

    # 通道 A：特殊字符串 → 人类更自信，噪声 ×0.7
    bias_factor = _special_bias(x)
    if bias_factor > 1.0:
        unc *= 0.70

    # 通道 B：重计算性质 → 覆盖字符串结构，强制高噪声
    heavy = property_id in HEAVY_NUMERIC if property_id else False
    if heavy:
        unc = max(unc, 0.85)

    # 噪声
    noise_factor = unc * (1.0 - 0.8 * skill) + 0.2 * (1.0 - skill)
    if memory_blur > 1.0:
        noise_factor *= memory_blur
    sigma = max(true_ep * noise_factor, 1.0)

    # 偏置
    if heavy:
        bias = 0.0
    else:
        bias = true_ep * (bias_factor - 1.0) * (1.0 - skill)

    return max(0.0, true_ep + random.gauss(bias, sigma))


# ============================================================
# DP 阈值（target 模式 + 内部网页游戏用）
# ============================================================
def compute_thresholds(samples, n=GAME_LEN, k=MAX_PICKS,
                       shrink=0.88, use_quantile_cap=True, urgency_window=2):
    m = len(samples)
    if m == 0:
        return None

    ss = sorted(samples)
    cumsum = [0] * (m + 1)
    for i, v in enumerate(ss):
        cumsum[i + 1] = cumsum[i] + v
    total = cumsum[m]
    mean = total / m

    def quantile(level):
        if level <= 0:
            return ss[0]
        if level >= 1:
            return ss[-1]
        pos = (m - 1) * level
        lo = int(pos)
        hi = min(lo + 1, m - 1)
        frac = pos - lo
        return ss[lo] * (1 - frac) + ss[hi] * frac

    NEG = float("-inf")
    POS = float("inf")
    V = [[0.0] * (k + 1) for _ in range(n + 1)]
    tau = [[POS] * (k + 1) for _ in range(n + 1)]

    for r in range(1, n + 1):
        for q in range(1, min(k, r) + 1):
            if q == r:
                V[r][q] = mean + V[r - 1][q - 1]
                tau[r][q] = NEG
                continue
            v_skip = V[r - 1][q]
            v_take = V[r - 1][q - 1]
            t_dp = v_skip - v_take
            t = min(t_dp, quantile(1 - q / r)) if use_quantile_cap else t_dp
            if q >= r - urgency_window:
                t *= shrink ** 2
            else:
                t *= shrink
            idx = bisect_left(ss, t)
            above = (total - cumsum[idx]) - t * (m - idx)
            V[r][q] = v_skip + above / m
            tau[r][q] = t
    return tau


# ============================================================
# 对外会话
# ============================================================
class GameSession:
    def __init__(self, n=GAME_LEN, k=MAX_PICKS, mode=DEFAULT_MODE,
                 human_mode=DEFAULT_HUMAN_MODE, skill=DEFAULT_SKILL, target=None):
        self.id = uuid.uuid4().hex
        self.n = n
        self.k = k
        self.mode = mode
        self.human_mode = human_mode
        self.skill = skill
        self.target = target
        self.turn = 0
        self.ai_score = 0
        self.ai_picks = 0
        self.thresholds = None
        self.rounds = []
        self.created = time.time()
        self.last_active = self.created
        self.finished = False

        self.lock = threading.Lock()
        self.last_x = None
        self.last_step_time = 0.0

    # ---------- 辅助 ----------
    def _saved(self):
        return [(r["x"], r["f_x"]) for r in self.rounds if r["choose"]]

    def _ensure_thresholds(self):
        if self.thresholds is None and len(OBSERVED) >= MIN_SAMPLES_FOR_DP:
            self.thresholds = compute_thresholds(
                list(OBSERVED.values()), self.n, self.k
            )

    def _decide_target_dp(self, r, q, fx):
        self._ensure_thresholds()
        if q <= 0:
            return False, None
        if q >= r:
            return True, float("-inf")
        if self.thresholds is None:
            if self.turn < 5:
                return False, None
            vals = sorted(OBSERVED.values())
            if len(vals) < 5:
                return False, None
            med = vals[len(vals) // 2]
            return fx >= med, med
        t = self.thresholds[r][q]
        return fx >= t, t

    def _decide_collect(self, x, fx, property_id=None):
        r = self.n - self.turn
        q = self.k - self.ai_picks
        if q <= 0:
            return False, None
        if q >= r:
            # 名额不足，强制选（保证填满，但要注意 k 是否合理）
            return True, float("-inf")

        if not self.human_mode:
            return self._decide_target_dp(r, q, fx)

        cur_perceived = perceived_ep(x, fx, self.skill, property_id=property_id)
        saved = self._saved()

        # 已存数字的"记忆模糊"感知
        if saved:
            perceived_saved = [
                (num, perceived_ep(num, tep, self.skill * 0.6, memory_blur=1.3))
                for num, tep in saved
            ]
            worst_num, worst_val = min(perceived_saved, key=lambda t: t[1])
        else:
            worst_num, worst_val = None, None

        # 全局经验阈值：q/r 比例小 → 阈值高（应该精选）；比例大 → 阈值低
        # q/r=1 → 阈值在 p0（每轮都存）；q/r=1/6 → 阈值在 p83
        global_threshold = None
        if len(OBSERVED) >= 30:
            vals = sorted(OBSERVED.values())
            m = len(vals)
            rate = q / r  # 0~1
            target_q = max(0.0, 1.0 - rate)
            idx = min(int(m * target_q), m - 1)
            global_threshold = float(vals[idx])

        # --- 空槽 ---
        if not saved:
            if global_threshold is not None:
                # 空槽门槛：全局阈值的 60%（首轮放宽一点，避免一直空着）
                return (cur_perceived >= global_threshold * 0.6), cur_perceived
            # 冷启动（OBSERVED 不足 30）：50% 概率占坑
            return (random.random() < 0.50), cur_perceived

        # --- 未满 ---
        if len(saved) < self.k:
            # 存的条件：感知值 >= 最差已存 * 0.9，且（若已知全局阈值）不显著低于全局阈值
            ok_worst = cur_perceived >= worst_val * 0.90
            if global_threshold is not None:
                tol = max(global_threshold * 0.20, 1.0)
                ok_global = cur_perceived >= global_threshold - tol
            else:
                ok_global = True
            return (ok_worst and ok_global), cur_perceived

        # --- 已满 ---
        # 必须有"明显提升"才替换，margin 随 skill 降低而增大
        margin = max(worst_val * (0.10 + 0.20 * (1.0 - self.skill)), 1.5)
        if human_uncertainty(worst_num) < 0.3:
            margin *= 1.3
        ref = worst_val
        if global_threshold is not None:
            ref = max(ref, global_threshold)
        return (cur_perceived > ref + margin), cur_perceived
    # ---------- target：保留 ----------
    def _decide_target(self, x, fx):
        r = self.n - self.turn
        q = self.k - self.ai_picks
        if q <= 0:
            return False, None
        if q >= r:
            return True, float("-inf")

        if not self.human_mode or self.target is None:
            return self._decide_target_dp(r, q, fx)

        perceived_fx = perceived_ep(x, fx, self.skill)
        target_perceived = self.target + random.gauss(
            0, max(1.0, self.target * 0.05 * (1 - self.skill))
        )
        d_true = abs(fx - self.target)
        if d_true > max(self.target * 0.10, 30):
            return (random.random() < 0.7 + 0.2 * self.skill), perceived_fx

        tau = None
        if self.thresholds is not None:
            t_raw = self.thresholds[r][q]
            if t_raw == float("inf"):
                return False, perceived_fx
            if t_raw == float("-inf"):
                return True, perceived_fx
            tau = t_raw
        if tau is None:
            vals = sorted(OBSERVED.values())
            tau = vals[len(vals) // 2] if len(vals) >= 5 else self.target * 0.5
        return perceived_fx >= tau, perceived_fx

    # ---------- 对外 step ----------
    def step(self, x, y=None, property_id=None):
        with self.lock:
            return self._step_locked(x, y, property_id=property_id)

    def _step_locked(self, x, y=None, property_id=None):
        if self.finished:
            return {"error": "session already finished"}
        if self.turn >= self.n:
            return {"error": "no more turns"}

        now = time.time()
        # 幂等：同一 x 在窗口内重复提交
        if (self.last_x == x and self.rounds
                and now - self.last_step_time < IDEMPOTENT_WINDOW):
            return dict(self.rounds[-1], idempotent=True)

        fx = int(TABLE[x])

        if self.mode == "collect":
            choose, perceived = self._decide_collect(
                x, fx, property_id=property_id
            )
        elif self.mode == "target":
            if y is not None:
                self.target = y
            choose, perceived = self._decide_target(x, fx)
        else:
            return {"error": "unknown mode: {}".format(self.mode)}

        OBSERVED[x] = fx
        try:
            save_samples(OBSERVED)
        except Exception as e:
            print("[warn] save samples failed: {}".format(e), file=sys.stderr)

        if choose:
            self.ai_score += fx
            self.ai_picks += 1

        self.turn += 1
        self.last_x = x
        self.last_step_time = now
        self.last_active = now
        if self.turn >= self.n:
            self.finished = True

        perceived_out = None
        if (self.human_mode and isinstance(perceived, (int, float))
                and math.isfinite(perceived)):
            perceived_out = round(float(perceived), 2)

        rec = {
            "turn": self.turn,
            "x": x,
            "f_x": fx,
            "choose": bool(choose),
            "perceived_ep": perceived_out,
            "property_id": property_id,
            "ai_picks": self.ai_picks,
            "ai_score": self.ai_score,
            "samples": len(OBSERVED),
            "using_dp": self.thresholds is not None,
            "phase": "finished" if self.finished else "playing",
            "human_mode": self.human_mode,
            "skill": self.skill if self.human_mode else None,
            "mode": self.mode,
        }
        self.rounds.append(rec)
        return rec

    def state(self):
        return {
            "game_id": self.id,
            "n": self.n,
            "k": self.k,
            "mode": self.mode,
            "human_mode": self.human_mode,
            "skill": self.skill if self.human_mode else None,
            "turn": self.turn,
            "ai_score": self.ai_score,
            "ai_picks": self.ai_picks,
            "finished": self.finished,
            "rounds": self.rounds,
            "samples": len(OBSERVED),
            "using_dp": self.thresholds is not None,
        }


def cleanup_sessions():
    now = time.time()
    expired = [gid for gid, s in SESSIONS.items()
               if now - s.last_active > SESSION_TTL]
    for gid in expired:
        del SESSIONS[gid]


# ============================================================
# 内部网页游戏：保留 DP 策略
# ============================================================
def ai_decide_internal(turn_idx, fx):
    r = GAME_LEN - turn_idx
    q = MAX_PICKS - STATE["ai_picks"]
    if q <= 0:
        return False
    if q >= r:
        return True
    if STATE["thresholds"] is None:
        if turn_idx < 5:
            return False
        vals = sorted(OBSERVED.values())
        if len(vals) < 5:
            return False
        return fx >= vals[len(vals) // 2]
    t = STATE["thresholds"][r][q]
    if t == float("inf"):
        return False
    return fx >= t


# ============================================================
# CORS
# ============================================================
@app.after_request
def add_cors(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.before_request
def handle_preflight():
    if request.method == "OPTIONS":
        return "", 204


# ============================================================
# 路由
# ============================================================
@app.get("/")
def index():
    return render_template("collect_index.html")


@app.get("/api/score")
def api_score():
    return api_ep()


@app.get("/api/ep")
def api_ep():
    if TABLE is None:
        return jsonify({"error": "EP table not loaded"}), 500
    try:
        x = int(request.args["x"])
    except (KeyError, ValueError):
        return jsonify({"error": "需要整数参数 x"}), 400
    if not 0 <= x <= MAX_N:
        return jsonify({"error": "x 必须在 0..{}".format(MAX_N)}), 400
    return jsonify({"x": x, "f_x": int(TABLE[x])})


@app.get("/api/history/info")
def api_history_info():
    return jsonify({
        "samples": len(OBSERVED),
        "path": os.path.abspath(SAMPLES_PATH),
        "exists": os.path.exists(SAMPLES_PATH),
        "using_dp": len(OBSERVED) >= MIN_SAMPLES_FOR_DP,
        "min_for_dp": MIN_SAMPLES_FOR_DP,
        "default_mode": DEFAULT_MODE,
        "default_human_mode": DEFAULT_HUMAN_MODE,
        "default_skill": DEFAULT_SKILL,
    })


@app.post("/api/history/reset")
def api_reset_history():
    OBSERVED.clear()
    try:
        if os.path.exists(SAMPLES_PATH):
            os.remove(SAMPLES_PATH)
    except Exception as e:
        print("[warn] remove failed: {}".format(e), file=sys.stderr)
    return jsonify({"ok": True})


# ============================================================
# 外部对局：start / step / status / abort
# ============================================================
@app.post("/api/external/start")
def api_external_start():
    cleanup_sessions()
    data = request.get_json(silent=True) or {}

    try:
        n = int(data.get("n", GAME_LEN))
    except (TypeError, ValueError):
        n = GAME_LEN
    try:
        k = int(data.get("k", MAX_PICKS))
    except (TypeError, ValueError):
        k = MAX_PICKS

    mode = data.get("mode", DEFAULT_MODE)
    human_mode = bool(data.get("human_mode", DEFAULT_HUMAN_MODE))
    try:
        skill = float(data.get("skill", DEFAULT_SKILL))
    except (TypeError, ValueError):
        skill = DEFAULT_SKILL
    skill = max(0.0, min(1.0, skill))
    target = data.get("target")
    if target is not None:
        try:
            target = float(target)
        except (TypeError, ValueError):
            target = None

    if not (1 <= n <= 100):
        return jsonify({"error": "n 必须在 1..100"}), 400
    if not (1 <= k <= n):
        return jsonify({"error": "k 必须在 1..n"}), 400
    if mode not in ("target", "collect"):
        return jsonify({"error": "mode 必须是 target 或 collect"}), 400

    sess = GameSession(
        n=n, k=k, mode=mode, human_mode=human_mode,
        skill=skill, target=target,
    )
    SESSIONS[sess.id] = sess
    return jsonify({
        "ok": True,
        "game_id": sess.id,
        "n": n,
        "k": k,
        "mode": mode,
        "human_mode": human_mode,
        "skill": skill if human_mode else None,
        "samples": len(OBSERVED),
        "using_dp": len(OBSERVED) >= MIN_SAMPLES_FOR_DP,
    })


@app.post("/api/external/step")
def api_external_step():
    data = request.get_json(silent=True) or {}
    gid = data.get("game_id")
    if not gid or gid not in SESSIONS:
        return jsonify({"error": "invalid or expired game_id"}), 400
    try:
        x = int(data["x"])
    except (KeyError, ValueError):
        return jsonify({"error": "缺少整数 x"}), 400
    if not 0 <= x <= MAX_N:
        return jsonify({"error": "x 必须在 0..{}".format(MAX_N)}), 400

    y = data.get("y")
    if y is not None:
        try:
            y = float(y)
        except (TypeError, ValueError):
            y = None

    pid = data.get("property_id")
    if pid is not None:
        pid = str(pid)

    result = SESSIONS[gid].step(x, y, property_id=pid)
    if "error" in result:
        return jsonify(result), 400
    return jsonify(result)


@app.get("/api/external/status")
def api_external_status():
    gid = request.args.get("game_id", "")
    if gid not in SESSIONS:
        return jsonify({"error": "invalid or expired game_id"}), 404
    return jsonify(SESSIONS[gid].state())


@app.post("/api/external/abort")
def api_external_abort():
    data = request.get_json(silent=True) or {}
    gid = data.get("game_id", "")
    SESSIONS.pop(gid, None)
    return jsonify({"ok": True})


# ============================================================
# 内部网页游戏
# ============================================================
@app.post("/api/game/new")
def api_new_game():
    if len(OBSERVED) >= MIN_SAMPLES_FOR_DP:
        STATE["thresholds"] = compute_thresholds(list(OBSERVED.values()))
    else:
        STATE["thresholds"] = None

    STATE.update({
        "phase": "playing",
        "xs": [random.randint(0, MAX_N) for _ in range(GAME_LEN)],
        "turn": 0,
        "ai_score": 0,
        "human_score": 0,
        "ai_picks": 0,
        "human_picks": 0,
        "rounds": [],
    })
    return jsonify({
        "ok": True,
        "samples": len(OBSERVED),
        "using_dp": STATE["thresholds"] is not None,
    })


@app.get("/api/game/state")
def api_game_state():
    current_x = None
    current_fx = None
    if STATE["xs"] and STATE["turn"] < GAME_LEN:
        current_x = STATE["xs"][STATE["turn"]]
        current_fx = int(TABLE[current_x])
    return jsonify({
        "phase": STATE["phase"],
        "turn": STATE["turn"],
        "total_turns": GAME_LEN,
        "current_x": current_x,
        "current_fx": current_fx,
        "ai_score": STATE["ai_score"],
        "human_score": STATE["human_score"],
        "ai_picks": STATE["ai_picks"],
        "human_picks": STATE["human_picks"],
        "rounds": STATE["rounds"],
        "samples": len(OBSERVED),
        "using_dp": STATE["thresholds"] is not None,
    })


@app.post("/api/game/step")
def api_game_step():
    if STATE["phase"] != "playing":
        return jsonify({"error": "游戏未在进行中"}), 400
    if STATE["turn"] >= GAME_LEN:
        return jsonify({"error": "游戏已结束"}), 400

    data = request.get_json() or {}
    human_choice = bool(data.get("choose", False))

    turn_idx = STATE["turn"]
    x = STATE["xs"][turn_idx]
    fx = int(TABLE[x])

    ai_choice = ai_decide_internal(turn_idx, fx)
    OBSERVED[x] = fx

    if human_choice and STATE["human_picks"] < MAX_PICKS:
        STATE["human_score"] += fx
        STATE["human_picks"] += 1
        human_choice = True
    else:
        human_choice = False

    if ai_choice:
        STATE["ai_score"] += fx
        STATE["ai_picks"] += 1

    STATE["rounds"].append({
        "turn": turn_idx + 1,
        "x": x,
        "f_x": fx,
        "ai_choice": ai_choice,
        "human_choice": human_choice,
        "ai_score_after": STATE["ai_score"],
        "human_score_after": STATE["human_score"],
    })
    STATE["turn"] += 1
    if STATE["turn"] >= GAME_LEN:
        STATE["phase"] = "finished"

    try:
        save_samples(OBSERVED)
    except Exception as e:
        print("[warn] save failed: {}".format(e), file=sys.stderr)

    return jsonify({
        "ok": True,
        "turn": STATE["turn"],
        "phase": STATE["phase"],
        "ai_score": STATE["ai_score"],
        "human_score": STATE["human_score"],
        "ai_picks": STATE["ai_picks"],
        "human_picks": STATE["human_picks"],
    })


# ============================================================
# 启动
# ============================================================
def main():
    global TABLE, OBSERVED, SAMPLES_PATH
    global DEFAULT_MODE, DEFAULT_HUMAN_MODE, DEFAULT_SKILL

    ap = argparse.ArgumentParser()
    ap.add_argument("--table", default="ep-table.bin.gz")
    ap.add_argument("--samples", default="observed.json.gz")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=5001)
    ap.add_argument(
        "--skill", type=float, default=DEFAULT_SKILL,
        help="人类化强度 0~1。越低越像 4 秒内的人类；"
             "负数表示关闭 human_mode（恢复原始强 AI）",
    )
    ap.add_argument(
        "--mode", choices=["collect", "target"],
        default=DEFAULT_MODE,
        help="默认对局模式（油猴调用 collect）",
    )
    args = ap.parse_args()

    DEFAULT_MODE = args.mode
    if args.skill < 0:
        DEFAULT_HUMAN_MODE = False
        DEFAULT_SKILL = 0.25
    else:
        DEFAULT_HUMAN_MODE = True
        DEFAULT_SKILL = max(0.0, min(1.0, args.skill))

    print("loading {} …".format(args.table), file=sys.stderr)
    TABLE = load_table(args.table)
    print("  {:,} entries, EP {}..{}".format(len(TABLE), min(TABLE), max(TABLE)),
          file=sys.stderr)

    SAMPLES_PATH = args.samples
    OBSERVED = load_samples(SAMPLES_PATH)
    print("  loaded {} samples from {}".format(
        len(OBSERVED), os.path.abspath(SAMPLES_PATH)), file=sys.stderr)

    if DEFAULT_HUMAN_MODE:
        print("  external default: mode={}, human_mode=True, skill={}".format(
            DEFAULT_MODE, DEFAULT_SKILL), file=sys.stderr)
    else:
        print("  external default: mode={}, human_mode=False (强 AI)".format(
            DEFAULT_MODE), file=sys.stderr)

    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()