import unittest
import os
from unittest.mock import Mock, call, patch

os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ.setdefault("AUTH_PASSWORD", "test-password")

from nexa_pi_controller import radio


class RadioTestCase(unittest.TestCase):
    def test_mock_mode_does_not_require_gpio(self):
        with patch.object(radio, "GPIO_MODE", "mock"), \
                patch.object(radio, "lgpio", None):
            radio.transmit(True, 0)

    def test_missing_lgpio_explains_how_to_run_in_development_mode(self):
        with patch.object(radio, "GPIO_MODE", "hardware"), \
                patch.object(radio, "lgpio", None):
            with self.assertRaisesRegex(RuntimeError, "GPIO_MODE=mock"):
                radio.transmit(True, 0)

    def test_invalid_mode_is_rejected(self):
        with patch.object(radio, "GPIO_MODE", "invalid"):
            with self.assertRaisesRegex(RuntimeError, "GPIO_MODE must be"):
                radio.transmit(True, 0)

    def test_hardware_transmits_frame_and_closes_chip(self):
        gpio = Mock()
        gpio.gpiochip_open.return_value = 42
        ticks = [0]
        writes = []

        def clock():
            ticks[0] += 1
            return ticks[0]

        def write(handle, pin, level):
            writes.append((handle, pin, level, ticks[0]))

        gpio.gpio_write.side_effect = write
        with patch.object(radio, "GPIO_MODE", "hardware"), \
                patch.object(radio, "lgpio", gpio), \
                patch.object(radio, "TX_ID", 1), \
                patch.object(radio, "REPEAT", 1), \
                patch.object(radio, "T", 1), \
                patch.object(radio.time, "perf_counter", side_effect=clock):
            radio.transmit(True, 2, group=1)
        gpio.gpiochip_open.assert_called_once_with(radio.CHIP)
        gpio.gpio_claim_output.assert_called_once_with(42, radio.PIN, 0)
        bits = format(1, "026b") + "11" + format(2, "04b")
        pulses = [(1, 1), (0, 10)]
        for bit in bits:
            pulses.extend([(1, 1), (0, 5 if bit == "1" else 1),
                           (1, 1), (0, 1 if bit == "1" else 5)])
        pulses.extend([(1, 1), (0, 40)])
        self.assertEqual(
            gpio.gpio_write.call_args_list,
            [call(42, radio.PIN, level) for level, _ in pulses] + [call(42, radio.PIN, 0)],
        )
        self.assertEqual(
            [writes[index + 1][3] - writes[index][3] for index in range(len(pulses))],
            [duration + 1 for _, duration in pulses],
        )
        gpio.gpiochip_close.assert_called_once_with(42)

    def test_hardware_closes_chip_when_claim_fails(self):
        gpio = Mock()
        gpio.gpiochip_open.return_value = 42
        gpio.gpio_claim_output.side_effect = RuntimeError("claim failed")
        with patch.object(radio, "GPIO_MODE", "hardware"), \
                patch.object(radio, "lgpio", gpio):
            with self.assertRaisesRegex(RuntimeError, "claim failed"):
                radio.transmit(False, 1)
        gpio.gpio_write.assert_called_once_with(42, radio.PIN, 0)
        gpio.gpiochip_close.assert_called_once_with(42)

    def test_apply_transmits_before_updating_and_saving_state(self):
        state = {1: False}
        transmit = Mock()
        save = Mock()
        radio.apply(1, True, state, save, transmit)
        transmit.assert_called_once_with(True, 1)
        self.assertEqual(state, {1: True})
        save.assert_called_once_with(state)

    def test_apply_does_not_update_state_if_transmit_fails(self):
        state = {1: False}
        transmit = Mock(side_effect=RuntimeError("transmit failed"))
        save = Mock()
        with self.assertRaisesRegex(RuntimeError, "transmit failed"):
            radio.apply(1, True, state, save, transmit)
        self.assertEqual(state, {1: False})
        save.assert_not_called()
