#!/usr/bin/env python3
"""Human-readable Z.AI Coding Plan quota audit for pi sessions.

Answers:
- Would Lite/Pro/Max throttle me?
- Is problem 5-hour burst or weekly cap?
- What changes after September promo ends?
"""
import argparse, json, os, glob
from datetime import datetime, timedelta, timezone
from collections import Counter, defaultdict, deque


def parse_date(s, end=False):
    """Parse ccusage-style YYYYMMDD or ISO date. End dates are exclusive next-day."""
    if not s:
        return None
    raw = s.strip()
    for fmt in ("%Y%m%d", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
            return dt + timedelta(days=1) if end else dt
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        raise SystemExit(f"Bad date: {s}. Use YYYYMMDD or YYYY-MM-DD")


def parse_args():
    ap = argparse.ArgumentParser(description="Audit pi Z.AI Coding Plan usage")
    ap.add_argument("-s", "--start", "--since", help="start date, ccusage style YYYYMMDD or YYYY-MM-DD")
    ap.add_argument("-e", "--end", "--until", help="end date, exclusive next day for YYYYMMDD/YYYY-MM-DD")
    ap.add_argument("--days", type=int, help="last N days (ignored if --start set)")
    ap.add_argument("--sessions-dir", default=os.environ.get("PI_SESSIONS_DIR", "~/.pi/agent/sessions"))
    ap.add_argument("--promo-off", action="store_true", help="disable current off-peak 1x promo in primary calculation")
    return ap.parse_args()


ARGS = parse_args()
NOW = datetime.now(timezone.utc)
START = parse_date(ARGS.start) if ARGS.start else (NOW - timedelta(days=ARGS.days) if ARGS.days else None)
END = parse_date(ARGS.end, end=True) if ARGS.end else None
PROMO_OFFPEAK_1X = (os.environ.get("ZAI_PROMO_OFFPEAK_1X", "1") not in ("0", "false", "False")) and not ARGS.promo_off
SESSIONS = os.path.expanduser(ARGS.sessions_dir)

ZAI_MODELS = {
    "glm-5.3", "glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5-turbo", "glm-5v-turbo", "glm-5",
    "glm-4.7", "glm-4.7-flash", "glm-4.7-flashx", "glm-4.6", "glm-4.6v",
    "glm-4.6v-flash", "glm-4.5", "glm-4.5-air", "glm-4.5v",
}
ADVANCED = {"glm-5.2", "glm-5.2[1m]", "glm-5-turbo"}

CURRENT = {
    "Lite": {"5h": 80, "week": 400, "monthly": 18},
    "Pro": {"5h": 400, "week": 2000, "monthly": 72},
    "Max": {"5h": 1600, "week": 8000, "monthly": 160},
}
LEGACY_5H = {"Lite": 120, "Pro": 600, "Max": 2400}

# Z.AI API pricing per 1M tokens (input, output, cacheRead).
# Source: https://docs.z.ai/guides/overview/pricing
# Snapshot verified: 2026-07-08. Cache write ignored because Z.AI currently lists
# cache storage/write as limited-time free for these text models.
API_PRICING_SOURCE = "https://docs.z.ai/guides/overview/pricing"
API_PRICING_UPDATED = "2026-07-08"
API_PRICES = {
    "glm-5.2": (1.4, 4.4, 0.26),
    "glm-5.2[1m]": (1.4, 4.4, 0.26),
    "glm-5.1": (1.4, 4.4, 0.26),
    "glm-5-turbo": (1.2, 4.0, 0.24),
    "glm-5v-turbo": (1.2, 4.0, 0.24),
    "glm-5": (1.0, 3.2, 0.20),
    "glm-4.7": (0.6, 2.2, 0.11),
    "glm-4.6": (0.6, 2.2, 0.11),
    "glm-4.5": (0.6, 2.2, 0.11),
    "glm-4.5-air": (0.2, 1.1, 0.03),
}

# Your known legacy Pro annual payment. Override with env if needed.
LEGACY_MONTHLY_EQUIV = float(os.environ.get("ZAI_LEGACY_MONTHLY", "10.50"))
PRO_MIGRATION_MONTHLY_EQUIV = float(os.environ.get("ZAI_PRO_MIGRATION_MONTHLY", "28.83"))


def is_peak(dt):
    return 6 <= dt.hour < 10  # 14:00-18:00 UTC+8


def quota_cost(model, dt, promo):
    if model in ADVANCED:
        if is_peak(dt):
            return 3
        return 1 if promo else 2
    return 1


def day(dt): return dt.strftime("%Y-%m-%d")
def week(dt):
    iso = dt.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def fmt_num(n):
    if n >= 1_000_000_000: return f"{n/1_000_000_000:.1f}B"
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000: return f"{n/1_000:.1f}K"
    return str(n)


def mark(value, cap):
    return "FAIL" if value > cap else "ok"


def text_user(msg):
    if msg.get("role") != "user": return False
    c = msg.get("content", [])
    if isinstance(c, str): return bool(c.strip())
    if isinstance(c, list): return any(isinstance(x, dict) and x.get("type") == "text" for x in c)
    return False


def usage_parts(msg):
    u = msg.get("usage") or {}
    return {
        "input": int(u.get("input", 0) or 0),
        "output": int(u.get("output", 0) or 0),
        "cacheRead": int(u.get("cacheRead", 0) or 0),
        "cacheWrite": int(u.get("cacheWrite", 0) or 0),
    }


def usage_total(parts):
    return parts["input"] + parts["output"] + parts["cacheRead"] + parts["cacheWrite"]


def api_equiv_cost(model, parts):
    # Do not guess prices for newly released models missing from Z.AI's pricing page.
    price = API_PRICES.get(model) or API_PRICES.get(model.replace("[1m]", ""))
    if price is None:
        return 0.0
    pin, pout, pcache = price
    return (
        parts["input"] * pin
        + parts["output"] * pout
        + parts["cacheRead"] * pcache
    ) / 1_000_000


def load():
    files = glob.glob(os.path.join(SESSIONS, "**", "*.jsonl"), recursive=True)
    prompts = []
    assistant = []
    for f in files:
        cur_model = None
        try:
            with open(f) as fh:
                for line in fh:
                    line = line.strip()
                    if not line: continue
                    try: e = json.loads(line)
                    except Exception: continue
                    ts = e.get("timestamp", "")
                    try: dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    except Exception: continue
                    t = e.get("type")
                    if t == "model_change":
                        cur_model = e.get("modelId")
                        continue
                    if t != "message": continue
                    msg = e.get("message", {})
                    if START is not None and dt < START: continue
                    if END is not None and dt >= END: continue
                    if text_user(msg):
                        if cur_model in ZAI_MODELS:
                            prompts.append((dt, cur_model, f))
                    elif msg.get("role") == "assistant":
                        model = msg.get("model") or cur_model
                        provider = msg.get("provider")
                        if model in ZAI_MODELS or provider in ("zai", "zai-1m"):
                            assistant.append((dt, model or "?", usage_parts(msg)))
        except Exception:
            continue
    prompts.sort(key=lambda x: x[0])
    assistant.sort(key=lambda x: x[0])
    return files, prompts, assistant


def summarize(prompts, assistant, promo):
    daily = defaultdict(lambda: {"prompts": 0, "quota": 0, "models": Counter(), "tokens": 0, "peak5h": 0, "apiCost": 0.0})
    weekly = defaultdict(lambda: {"prompts": 0, "quota": 0, "tokens": 0, "apiCost": 0.0})
    monthly = defaultdict(lambda: {"prompts": 0, "quota": 0, "tokens": 0, "apiCost": 0.0, "calls": 0})
    total_quota = 0
    peak = off = 0

    q = deque()
    rolling = 0
    for dt, model, _ in prompts:
        cost = quota_cost(model, dt, promo)
        d, w = day(dt), week(dt)
        daily[d]["prompts"] += 1
        daily[d]["quota"] += cost
        daily[d]["models"][model] += 1
        weekly[w]["prompts"] += 1
        weekly[w]["quota"] += cost
        monthly[dt.strftime("%Y-%m")]["prompts"] += 1
        monthly[dt.strftime("%Y-%m")]["quota"] += cost
        total_quota += cost
        if is_peak(dt): peak += 1
        else: off += 1

        q.append((dt, cost))
        rolling += cost
        cutoff = dt - timedelta(hours=5)
        while q and q[0][0] <= cutoff:
            _old, old_cost = q.popleft()
            rolling -= old_cost
        daily[d]["peak5h"] = max(daily[d]["peak5h"], rolling)

    total_api_cost = 0.0
    total_tokens = 0
    calls = 0
    for dt, model, parts in assistant:
        d, w, m = day(dt), week(dt), dt.strftime("%Y-%m")
        toks = usage_total(parts)
        cost = api_equiv_cost(model, parts)
        daily[d]["tokens"] += toks
        weekly[w]["tokens"] += toks
        monthly[m]["tokens"] += toks
        daily[d]["apiCost"] += cost
        weekly[w]["apiCost"] += cost
        monthly[m]["apiCost"] += cost
        monthly[m]["calls"] += 1
        total_api_cost += cost
        total_tokens += toks
        calls += 1

    return {
        "daily": daily,
        "weekly": weekly,
        "monthly": monthly,
        "quota": total_quota,
        "peak": peak,
        "off": off,
        "apiCost": total_api_cost,
        "tokens": total_tokens,
        "calls": calls,
    }


def tier_totals(stats, caps):
    rows = []
    for tier, cap in caps.items():
        bad_days = sum(1 for d in stats["daily"].values() if d["peak5h"] > cap["5h"])
        bad_weeks = sum(1 for w in stats["weekly"].values() if w["quota"] > cap["week"])
        max5 = max((d["peak5h"] for d in stats["daily"].values()), default=0)
        maxw = max((w["quota"] for w in stats["weekly"].values()), default=0)
        rows.append((tier, bad_days, len(stats["daily"]), max5, cap["5h"], bad_weeks, len(stats["weekly"]), maxw, cap["week"]))
    return rows


def print_verdict(promo, after_sep):
    promo_rows = {r[0]: r for r in tier_totals(promo, CURRENT)}
    after_rows = {r[0]: r for r in tier_totals(after_sep, CURRENT)}
    print("Bottom line")
    print("-----------")
    print(f"Lite: fails during promo ({promo_rows['Lite'][1]} days hit 5h cap, {promo_rows['Lite'][5]} weeks hit weekly cap).")
    if after_rows["Pro"][1] or after_rows["Pro"][5]:
        print(f"Pro: mostly fits, but after September has risk ({after_rows['Pro'][1]} days / {after_rows['Pro'][5]} weeks fail).")
    else:
        print("Pro: fits this machine sample, even after September projection.")
    print("Max: fits with huge headroom on this machine.")
    print("Legacy Pro: prompt-count says it should fit; your hit likely from hidden token/complexity throttle.")


def print_tier_summary(title, stats, caps):
    print(f"\n{title}")
    print("Tier   result       worst 5h        worst week      meaning")
    print("----   ------       --------        ----------      -------")
    for tier, bad_d, days, max5, cap5, bad_w, weeks, maxw, capw in tier_totals(stats, caps):
        result = "FAIL" if bad_d or bad_w else "ok"
        meaning = []
        if bad_d: meaning.append(f"5h failed {bad_d}/{days} days")
        if bad_w: meaning.append(f"week failed {bad_w}/{weeks} weeks")
        if not meaning: meaning.append("no cap hits")
        print(f"{tier:<5}  {result:<10}   {max5:>4}/{cap5:<7}   {maxw:>4}/{capw:<9}   {', '.join(meaning)}")


def print_legacy_summary(promo):
    print("\nLegacy archived 5-hour caps")
    print("Tier   result       worst 5h        meaning")
    print("----   ------       --------        -------")
    for tier, cap in LEGACY_5H.items():
        bad_d = sum(1 for d in promo["daily"].values() if d["peak5h"] > cap)
        max5 = max((d["peak5h"] for d in promo["daily"].values()), default=0)
        result = "FAIL" if bad_d else "ok"
        meaning = f"5h failed {bad_d}/{len(promo['daily'])} days" if bad_d else "no prompt-count cap hits"
        print(f"{tier:<5}  {result:<10}   {max5:>4}/{cap:<7}   {meaning}")


def print_daily(promo, after_sep):
    print("\nDaily breakdown")
    print("Date        queries  API$     tokens   5h promo  5h afterSep   quota promo/afterSep   cap result")
    print("----------  -------  -------  -------  --------  ------------   --------------------   ----------")
    for d in sorted(set(promo["daily"]) | set(after_sep["daily"])):
        n = promo["daily"].get(d, {})
        p = after_sep["daily"].get(d, {})
        peak_now = n.get("peak5h", 0)
        peak_post = p.get("peak5h", 0)
        fails = []
        if peak_now > CURRENT["Lite"]["5h"]: fails.append("Lite-5h")
        if peak_post > CURRENT["Lite"]["5h"] and "Lite-5h" not in fails: fails.append("Lite-5h-afterSep")
        if peak_now > CURRENT["Pro"]["5h"]: fails.append("Pro-5h")
        if peak_post > CURRENT["Pro"]["5h"] and "Pro-5h" not in fails: fails.append("Pro-5h-afterSep")
        if not fails: fails.append("none")
        print(f"{d}  {n.get('prompts',0):7d}  ${n.get('apiCost',0):6.2f}  {fmt_num(n.get('tokens',0)):>7}  {peak_now:8d}  {peak_post:12d}   {n.get('quota',0):8d}/{p.get('quota',0):<11d}   {', '.join(fails)}")


def print_weekly(promo, after_sep):
    print("\nWeekly breakdown")
    print("Week        queries  API$      tokens   quota promo/afterSep   Lite weekly       Pro weekly        Max weekly")
    print("----------  -------  -------  -------  --------------------   ---------------   --------------    --------------")
    for w in sorted(set(promo["weekly"]) | set(after_sep["weekly"])):
        n = promo["weekly"].get(w, {})
        p = after_sep["weekly"].get(w, {})
        qn, qp = n.get("quota", 0), p.get("quota", 0)
        print(f"{w:10s}  {n.get('prompts',0):7d}  ${n.get('apiCost',0):6.2f}  {fmt_num(n.get('tokens',0)):>7}  {qn:8d}/{qp:<11d}   promo:{mark(qn,400):<4} after:{mark(qp,400):<4}   promo:{mark(qn,2000):<4} after:{mark(qp,2000):<4}   promo:{mark(qn,8000):<4} after:{mark(qp,8000):<4}")


def print_api_pricing():
    print("\nAPI pricing used")
    print("----------------")
    print(f"Snapshot: {API_PRICING_UPDATED}")
    print(f"Source:   {API_PRICING_SOURCE}")
    print("Prices:   USD per 1M tokens")
    print("\nModel            input   output  cacheRead  cache write/storage")
    print("-----            -----   ------  ---------  -------------------")
    for model in ["glm-5.2", "glm-5.1", "glm-5-turbo", "glm-5v-turbo", "glm-5", "glm-4.7", "glm-4.5-air"]:
        pin, pout, pcache = API_PRICES[model]
        print(f"{model:<16} ${pin:<5.2f}  ${pout:<5.2f}  ${pcache:<8.2f} free/ignored")
    print("\nFormula: (input*input_price + output*output_price + cacheRead*cacheRead_price) / 1,000,000")
    print("Coding Plan is subscription quota, not API billing. API$ = equivalent value yardstick.")
    print("Models absent from public pricing (currently GLM-5.3) contribute $0 until pricing is published.")


def print_api_value(promo):
    print("\nAPI-equivalent value")
    print("--------------------")
    print(f"API-equivalent cost in this report window: ${promo['apiCost']:.2f}")
    print(f"Pricing snapshot: {API_PRICING_UPDATED} from {API_PRICING_SOURCE}")
    print(f"Z.AI model calls recorded by pi: {promo['calls']:,}")
    print(f"Tokens recorded by pi: {fmt_num(promo['tokens'])}")
    print("\nMonthly API-equivalent cost:")
    print("Month      API$     tokens    calls   value vs legacy $10.50/mo   value vs Pro migration $28.83/mo")
    print("--------   -------  -------   -----   --------------------------   -------------------------------")
    for m in sorted(promo["monthly"]):
        row = promo["monthly"][m]
        legacy_mult = row["apiCost"] / LEGACY_MONTHLY_EQUIV if LEGACY_MONTHLY_EQUIV else 0
        pro_mult = row["apiCost"] / PRO_MIGRATION_MONTHLY_EQUIV if PRO_MIGRATION_MONTHLY_EQUIV else 0
        print(f"{m:8s}   ${row['apiCost']:6.2f}  {fmt_num(row['tokens']):>7}   {row.get('calls', 0):5d}   {legacy_mult:6.1f}x legacy monthly      {pro_mult:6.1f}x Pro-migration monthly")
    print("\nZ.AI says monthly quota ~= 15–30x subscription fee by API pricing. This table compares your real token usage to that yardstick.")


def print_models(promo):
    print("\nModel mix")
    print("Model            prompts  share  note")
    print("-----            -------  -----  ----")
    total = sum(x["prompts"] for x in promo["daily"].values()) or 1
    c = Counter()
    for d in promo["daily"].values(): c.update(d["models"])
    for model, count in c.most_common():
        note = "advanced multiplier" if model in ADVANCED else "standard/unknown multiplier"
        print(f"{model:<16} {count:7d}  {100*count/total:4.0f}%  {note}")


def main():
    files, prompts, assistant = load()
    promo = summarize(prompts, assistant, PROMO_OFFPEAK_1X)
    after_sep = summarize(prompts, assistant, False)
    p = len(prompts)

    if START or END:
        start_s = START.strftime("%Y-%m-%d") if START else "beginning"
        end_s = (END - timedelta(days=1)).strftime("%Y-%m-%d") if END else "now"
        window_label = f"{start_s} to {end_s}"
    else:
        window_label = "all pi history"
    if START:
        days_span = max(1, ((END or NOW) - START).days)
        per_day = f"{p/days_span:.0f}/day"
    elif END:
        per_day = "n/a"
    else:
        per_day = "all history"
    print(f"Z.AI quota report — {window_label} — {os.uname().nodename}")
    print("=" * 72)
    print_verdict(promo, after_sep)

    print("\nCore numbers")
    print("------------")
    print(f"Visible queries:         {p:,}  ({per_day})")
    print(f"Estimated model calls:   {p*15:,}–{p*20:,}  (Z.AI says 15–20 per prompt)")
    print(f"Quota spent during promo:{promo['quota']:,}  (off-peak promo 1x = {PROMO_OFFPEAK_1X})")
    print(f"Quota spent after Sep:   {after_sep['quota']:,}  (GLM-5.2/5-Turbo off-peak becomes 2x)")
    print(f"API-equivalent cost:     ${promo['apiCost']:.2f}")
    print(f"Peak/off-peak prompts:   {promo['peak']:,}/{promo['off']:,}")
    print(f"Sessions scanned:        {len(files)}")

    print_tier_summary("Current plans — through September promo", promo, CURRENT)
    print_tier_summary("Current plans — after September promo ends", after_sep, CURRENT)
    print_legacy_summary(promo)
    print_api_value(promo)
    print_api_pricing()
    print_daily(promo, after_sep)
    print_weekly(promo, after_sep)
    print_models(promo)

    print("\nLegend")
    print("------")
    print("5h-burst = highest rolling 5-hour quota spend that day. This is the 5-hour cap risk.")
    print("daily quota = total quota spend that date. It is NOT a daily cap; useful for scale only.")
    print("weekly quota = spend compared against Lite 400 / Pro 2000 / Max 8000 weekly caps.")
    print("afterSep = estimate after off-peak promo ends; GLM-5.2/5-Turbo count 2x off-peak.")
    print("Visible queries are pi user messages routed to Z.AI. Provider-side billing may differ.")
    print("API-equivalent cost uses Z.AI public token prices against pi usage records.")
    print("Z.AI caps are quota/query based, but hidden throttles may consider token/complexity pressure.")
    print("Docs: https://docs.z.ai/devpack/overview#usage-instruction")
    print("Legacy archive: https://web.archive.org/web/20260106170952/https://z.ai/subscribe")


if __name__ == "__main__":
    main()
