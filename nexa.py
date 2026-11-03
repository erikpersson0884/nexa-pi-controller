#!/usr/bin/env python3
# Nexa self-learning transmitter for Raspberry Pi 5 (lgpio)
# Usage: python3 nexa.py on|off [unit]

import sys
import time
import lgpio

CHIP = 15           # pinctrl-rp1 on your Pi (from gpiodetect)
PIN = 17            # BCM GPIO17 = physical pin 11
TX_ID = 12345678    # your made-up transmitter ID (0 - 67108863)
T = 260e-6          # base pulse length in seconds
REPEAT = 6          # how many times each command is sent

try:
    h = lgpio.gpiochip_open(CHIP)
    lgpio.gpio_claim_output(h, PIN, 0)
except Exception as e:
    sys.exit(f"GPIO error: {e}")


def pulse(level, duration):
    lgpio.gpio_write(h, PIN, level)
    end = time.perf_counter() + duration
    while time.perf_counter() < end:
        pass


def send_bit(bit):
    if bit:
        seq = [(1, T), (0, 5 * T), (1, T), (0, T)]
    else:
        seq = [(1, T), (0, T), (1, T), (0, 5 * T)]
    for level, duration in seq:
        pulse(level, duration)


def send(state, unit, group=0):
    bits = (
        format(TX_ID, "026b")
        + str(group)
        + ("1" if state else "0")
        + format(unit, "04b")
    )
    for _ in range(REPEAT):
        pulse(1, T)
        pulse(0, 10 * T)        # sync
        for c in bits:
            send_bit(c == "1")
        pulse(1, T)
        pulse(0, 40 * T)        # stop / pause


if len(sys.argv) < 2 or sys.argv[1] not in ("on", "off"):
    sys.exit("Usage: python3 nexa.py on|off [unit]")

unit = int(sys.argv[2]) if len(sys.argv) > 2 else 0

try:
    send(sys.argv[1] == "on", unit)
finally:
    lgpio.gpio_write(h, PIN, 0)
    lgpio.gpiochip_close(h)
