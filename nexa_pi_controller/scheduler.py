"""Background timer scheduler."""

import time
from datetime import datetime


def scheduler(timers, apply, save_timers, timer_lock, last_fired):
    while True:
        try:
            now = datetime.now()
            hhmm = now.strftime("%H:%M")
            stamp = now.strftime("%Y-%m-%d %H:%M")
            due = []
            with timer_lock:
                for schedule in timers["schedules"]:
                    if (schedule["enabled"] and schedule["time"] == hhmm
                            and now.weekday() in schedule["days"]
                            and last_fired.get(schedule["id"]) != stamp):
                        last_fired[schedule["id"]] = stamp
                        due.append((schedule["unit"], schedule["action"] == "on"))

                keep = []
                for countdown in timers["countdowns"]:
                    late = time.time() - countdown["run_at"]
                    if late < 0:
                        keep.append(countdown)
                    elif late <= 60:
                        due.append((countdown["unit"], countdown["action"] == "on"))
                if len(keep) != len(timers["countdowns"]):
                    timers["countdowns"] = keep
                    save_timers()

            for unit, on in due:
                try:
                    apply(unit, on)
                except Exception as e:
                    print("Timer failed to send:", e, flush=True)
                time.sleep(0.2)
        except Exception as e:
            print("Scheduler error:", e, flush=True)
        time.sleep(1)
