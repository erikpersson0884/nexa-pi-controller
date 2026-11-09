import threading
import unittest
from datetime import datetime
from unittest.mock import Mock, call, patch

from nexa_pi_controller import scheduler


class StopScheduler(BaseException):
    pass


class SchedulerTestCase(unittest.TestCase):
    def run_iterations(self, timers, apply, save, last_fired, iterations=1):
        now = datetime(2026, 11, 9, 12, 30)
        with patch.object(scheduler, "datetime") as clock, \
                patch.object(scheduler.time, "time", return_value=1000), \
                patch.object(scheduler.time, "sleep") as sleep:
            clock.now.return_value = now
            remaining = iterations

            def stop_after_iterations(seconds):
                nonlocal remaining
                if seconds == 1:
                    remaining -= 1
                    if remaining == 0:
                        raise StopScheduler()

            sleep.side_effect = stop_after_iterations
            with self.assertRaises(StopScheduler):
                scheduler.scheduler(timers, apply, save, threading.Lock(), last_fired)

    def test_due_schedules_are_fired_once_and_countdowns_expire(self):
        schedules = [
            {"id": "due", "unit": 1, "action": "on", "enabled": True, "time": "12:30", "days": [0]},
            {"id": "disabled", "unit": 2, "action": "on", "enabled": False, "time": "12:30", "days": [0]},
            {"id": "wrong-day", "unit": 3, "action": "on", "enabled": True, "time": "12:30", "days": [1]},
            {"id": "wrong-time", "unit": 4, "action": "on", "enabled": True, "time": "12:31", "days": [0]},
        ]
        future = {"unit": 7, "action": "on", "run_at": 1001}
        timers = {"schedules": schedules, "countdowns": [
            {"unit": 5, "action": "off", "run_at": 940},
            {"unit": 6, "action": "on", "run_at": 939},
            future,
        ]}
        apply = Mock()
        save = Mock()
        last_fired = {}
        self.run_iterations(timers, apply, save, last_fired, iterations=2)
        self.assertEqual(apply.call_args_list, [call(1, True), call(5, False)])
        self.assertEqual(timers["countdowns"], [future])
        self.assertEqual(last_fired, {"due": "2026-11-09 12:30"})
        save.assert_called_once_with()

    def test_failed_command_does_not_prevent_later_commands(self):
        timers = {"schedules": [], "countdowns": [
            {"unit": 1, "action": "on", "run_at": 1000},
            {"unit": 2, "action": "off", "run_at": 1000},
        ]}
        apply = Mock(side_effect=[RuntimeError("radio unavailable"), None])
        save = Mock()
        with patch("builtins.print") as output:
            self.run_iterations(timers, apply, save, {})
        self.assertEqual(apply.call_args_list, [call(1, True), call(2, False)])
        self.assertIn("radio unavailable", str(output.call_args))
        save.assert_called_once_with()

    def test_scheduler_logs_errors_and_keeps_running(self):
        timers = {"schedules": [], "countdowns": []}
        with patch("builtins.print") as output:
            self.run_iterations(timers, Mock(), Mock(), {})
        output.assert_not_called()
        with patch.object(scheduler, "datetime") as clock, \
                patch.object(scheduler.time, "sleep", side_effect=StopScheduler), \
                patch("builtins.print") as output:
            clock.now.side_effect = RuntimeError("clock error")
            with self.assertRaises(StopScheduler):
                scheduler.scheduler(timers, Mock(), Mock(), threading.Lock(), {})
        self.assertIn("clock error", str(output.call_args))
