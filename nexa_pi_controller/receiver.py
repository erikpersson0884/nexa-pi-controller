"""Nexa 433 MHz receiver and self-learning frame decoder."""

import os
import logging
import queue
import threading
import time

from ._gpio import lgpio
from .config import CHIP, GPIO_MODE, RX_PIN, TX_ID

ON_BIT = os.getenv("ON_BIT", "1")

SYNC_MIN, SYNC_MAX = 2000, 3600
HIGH_MIN, HIGH_MAX = 120, 800
LOW_SPLIT = 800
LOW_MAX = 2100
logger = logging.getLogger(__name__)


def decode_frame(bits):
    """Return (transmitter, group, on, unit) for a 32-bit Nexa frame."""
    if len(bits) != 32 or any(bit not in "01" for bit in bits):
        raise ValueError("Nexa frame must contain exactly 32 binary bits")
    return (
        int(bits[:26], 2),
        bits[26] == "1",
        bits[27] == ON_BIT,
        int(bits[28:], 2),
    )


class Decoder:
    def __init__(self, on_frame):
        self.on_frame = on_frame
        self.collecting = False
        self.parts = []
        self.bits = ""

    def reset(self):
        self.collecting = False
        self.parts = []
        self.bits = ""

    def pulse(self, level, duration):
        if level == 0 and SYNC_MIN <= duration <= SYNC_MAX:
            self.collecting = True
            self.parts = []
            self.bits = ""
            return
        if not self.collecting:
            return

        expected = 1 if len(self.parts) % 2 == 0 else 0
        if level != expected:
            self.reset()
            return
        self.parts.append(duration)
        if len(self.parts) < 4:
            return

        h1, l1, h2, l2 = self.parts
        self.parts = []
        if not (HIGH_MIN <= h1 <= HIGH_MAX and HIGH_MIN <= h2 <= HIGH_MAX):
            self.reset()
            return
        if l1 > LOW_SPLIT and l2 <= LOW_SPLIT and l1 <= LOW_MAX:
            self.bits += "1"
        elif l1 <= LOW_SPLIT and l2 > LOW_SPLIT and l2 <= LOW_MAX:
            self.bits += "0"
        else:
            self.reset()
            return

        if len(self.bits) == 32:
            bits = self.bits
            self.reset()
            self.on_frame(bits)


class Receiver:
    def __init__(self, on_command):
        self.handle_command = on_command
        self.commands = queue.Queue()
        self.worker = None
        self.stop_event = threading.Event()
        self.worker_lock = threading.Lock()
        self.decoder = Decoder(self.handle_frame)
        self.previous = None
        self.last_report = (None, 0.0)
        self.last_timestamp = None
        self.handle = None
        self.callback = None

    def on_command(self, transmitter, group, on, unit):
        self.commands.put((transmitter, group, on, unit))

    def _start_worker(self):
        with self.worker_lock:
            if self.worker is not None and self.worker.is_alive():
                return
            self.stop_event.clear()
            self.worker = threading.Thread(
                target=self._work, name="nexa-receiver", daemon=True
            )
            self.worker.start()

    def _work(self):
        while not self.stop_event.is_set():
            try:
                command = self.commands.get(timeout=0.2)
            except queue.Empty:
                continue
            if command is None:
                break
            try:
                transmitter, group, on, unit = command
                if transmitter == TX_ID:
                    continue
                self.handle_command(transmitter, group, on, unit)
            except Exception:
                logger.exception("Nexa receiver command handling failed")

    def handle_frame(self, bits):
        now = time.monotonic()
        confirmed = (
            self.previous is not None
            and self.previous[0] == bits
            and now - self.previous[1] < 0.5
        )
        self.previous = (bits, now)
        if not confirmed:
            return
        repeated = self.last_report[0] == bits and now - self.last_report[1] < 1.0
        self.last_report = (bits, now)
        if repeated:
            return
        self.on_command(*decode_frame(bits))

    def simulate(self, transmitter, group, on, unit):
        """Queue a decoded command for testing without radio hardware."""
        self.on_command(transmitter, group, on, unit)

    def on_edge(self, _chip, _gpio, level, timestamp):
        if level not in (0, 1):
            return
        if self.last_timestamp is not None:
            duration = (timestamp - self.last_timestamp) / 1000.0
            self.decoder.pulse(1 - level, duration)
        self.last_timestamp = timestamp

    def start(self):
        if GPIO_MODE != "hardware":
            self._start_worker()
            return False
        if lgpio is None:
            raise RuntimeError(
                "lgpio is not installed; set GPIO_MODE=mock for development"
            )
        self.handle = lgpio.gpiochip_open(CHIP)
        try:
            lgpio.gpio_claim_alert(
                self.handle, RX_PIN, lgpio.BOTH_EDGES, lgpio.SET_PULL_DOWN
            )
            self.callback = lgpio.callback(
                self.handle, RX_PIN, lgpio.BOTH_EDGES, self.on_edge
            )
        except Exception:
            lgpio.gpiochip_close(self.handle)
            self.handle = None
            raise
        self._start_worker()
        print(f"Listening for Nexa commands on GPIO{RX_PIN}", flush=True)
        return True

    def stop(self):
        if self.callback is not None:
            self.callback.cancel()
            self.callback = None
        if self.handle is not None:
            lgpio.gpiochip_close(self.handle)
            self.handle = None
        self.stop_event.set()
        self.commands.put(None)
        if self.worker is not None and self.worker is not threading.current_thread():
            self.worker.join(timeout=1)
            self.worker = None
