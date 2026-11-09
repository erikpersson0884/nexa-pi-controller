"""Nexa radio transmission and outlet state application."""

import threading
import time

try:
    import lgpio
except ImportError:
    lgpio = None

from .config import CHIP, GPIO_MODE, PIN, REPEAT, T, TX_ID

tx_lock = threading.Lock()


def transmit(on, unit, group=0):
    """Send one Nexa command. Opens and closes the GPIO each time."""
    if GPIO_MODE == "mock":
        print(
            f"Mock radio: {'on' if on else 'off'} unit {unit} group {group}",
            flush=True,
        )
        return
    if GPIO_MODE != "hardware":
        raise RuntimeError("GPIO_MODE must be 'hardware' or 'mock'")
    if lgpio is None:
        raise RuntimeError(
            "lgpio is not installed; set GPIO_MODE=mock for development"
        )
    with tx_lock:
        handle = lgpio.gpiochip_open(CHIP)
        try:
            lgpio.gpio_claim_output(handle, PIN, 0)

            def pulse(level, duration):
                lgpio.gpio_write(handle, PIN, level)
                end = time.perf_counter() + duration
                while time.perf_counter() < end:
                    pass

            def send_bit(bit):
                sequence = ([(1, T), (0, 5 * T), (1, T), (0, T)] if bit
                            else [(1, T), (0, T), (1, T), (0, 5 * T)])
                for level, duration in sequence:
                    pulse(level, duration)

            bits = (format(TX_ID, "026b") + str(group)
                    + ("1" if on else "0") + format(unit, "04b"))
            for _ in range(REPEAT):
                pulse(1, T)
                pulse(0, 10 * T)
                for bit in bits:
                    send_bit(bit == "1")
                pulse(1, T)
                pulse(0, 40 * T)
        finally:
            lgpio.gpio_write(handle, PIN, 0)
            lgpio.gpiochip_close(handle)


def apply(unit, on, state, save_state, transmit_fn=None):
    (transmit_fn or transmit)(on, unit)
    state[unit] = on
    save_state(state)
