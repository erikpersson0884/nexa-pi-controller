import unittest
import threading
import time
from unittest.mock import Mock, patch

from nexa_pi_controller import receiver


class ReceiverTestCase(unittest.TestCase):
    def test_decode_frame(self):
        bits = format(12345679, "026b") + "01" + format(4, "04b")

        self.assertEqual(
            receiver.decode_frame(bits),
            (12345679, False, True, 4),
        )

    def test_repeated_frame_is_required_and_debounced(self):
        commands = []
        received = threading.Event()

        def on_command(*command):
            commands.append(command)
            received.set()

        listener = receiver.Receiver(on_command)
        bits = format(12345679, "026b") + "01" + format(4, "04b")

        with patch.object(receiver, "GPIO_MODE", "mock"), \
                patch.object(receiver.time, "monotonic", side_effect=[1.0, 1.1, 1.2]):
            listener.start()
            listener.handle_frame(bits)
            listener.handle_frame(bits)
            self.assertTrue(received.wait(1))

        self.assertEqual(commands, [(12345679, False, True, 4)])
        listener.stop()

    def test_simulate_ignores_app_transmissions(self):
        commands = []
        listener = receiver.Receiver(lambda *command: commands.append(command))
        with patch.object(receiver, "GPIO_MODE", "mock"):
            listener.start()
            listener.simulate(receiver.TX_ID, False, True, 2)
            listener.simulate(receiver.TX_ID + 1, False, False, 2)
            deadline = time.monotonic() + 1
            while len(commands) < 1 and time.monotonic() < deadline:
                time.sleep(0.01)
        listener.stop()
        self.assertEqual(commands, [(receiver.TX_ID + 1, False, False, 2)])

    def test_mock_mode_does_not_open_gpio(self):
        listener = receiver.Receiver(lambda *_command: None)
        self.addCleanup(listener.stop)
        with patch.object(receiver, "GPIO_MODE", "mock"):
            self.assertFalse(listener.start())

    def test_decode_rejects_invalid_frames(self):
        for bits in ("0" * 31, "0" * 33, "0" * 31 + "x"):
            with self.subTest(bits=bits), self.assertRaises(ValueError):
                receiver.decode_frame(bits)

    def test_decoder_assembles_frame_from_pulses(self):
        frames = []
        decoder = receiver.Decoder(frames.append)
        bits = format(12345679, "026b") + "01" + format(4, "04b")
        decoder.pulse(0, 2600)
        for bit in bits:
            for level, duration in (
                (1, 260), (0, 1300 if bit == "1" else 260),
                (1, 260), (0, 260 if bit == "1" else 1300),
            ):
                decoder.pulse(level, duration)
        self.assertEqual(frames, [bits])
        self.assertFalse(decoder.collecting)
        self.assertEqual(decoder.bits, "")

    def test_decoder_resets_on_invalid_sequence_or_pulse_width(self):
        cases = [
            [(0, 100)],
            [(1, 100), (0, 260), (1, 260), (0, 1300)],
            [(1, 260), (0, 260), (1, 260), (0, 260)],
            [(1, 260), (0, 3601), (1, 260), (0, 260)],
        ]
        for pulses in cases:
            with self.subTest(pulses=pulses):
                decoder = receiver.Decoder(Mock())
                decoder.pulse(0, 2600)
                for level, duration in pulses:
                    decoder.pulse(level, duration)
                self.assertFalse(decoder.collecting)
                self.assertEqual(decoder.bits, "")

    def test_on_edge_uses_previous_level_and_microseconds(self):
        listener = receiver.Receiver(Mock())
        listener.decoder.pulse = Mock()
        listener.on_edge(0, 0, 1, 1_000_000)
        listener.on_edge(0, 0, 2, 1_100_000)
        listener.on_edge(0, 0, 0, 1_260_000)
        listener.decoder.pulse.assert_called_once_with(1, 260.0)

    def test_confirmed_frames_are_debounced(self):
        listener = receiver.Receiver(Mock())
        bits = format(12345679, "026b") + "01" + format(4, "04b")
        with patch.object(receiver.time, "monotonic", side_effect=[1.0, 1.1, 1.2, 2.3, 2.4]):
            for _ in range(5):
                listener.handle_frame(bits)
        self.assertEqual(listener.commands.qsize(), 2)
        self.assertEqual(listener.commands.get_nowait(), (12345679, False, True, 4))
        self.assertEqual(listener.commands.get_nowait(), (12345679, False, True, 4))

    def test_hardware_receiver_starts_and_releases_resources(self):
        gpio = Mock()
        gpio.gpiochip_open.return_value = 42
        listener = receiver.Receiver(Mock())
        with patch.object(receiver, "GPIO_MODE", "hardware"), \
                patch.object(receiver, "lgpio", gpio):
            self.assertTrue(listener.start())
            callback = gpio.callback.return_value
            listener.stop()
        gpio.gpio_claim_alert.assert_called_once_with(
            42, receiver.RX_PIN, gpio.BOTH_EDGES, gpio.SET_PULL_DOWN
        )
        gpio.callback.assert_called_once_with(
            42, receiver.RX_PIN, gpio.BOTH_EDGES, listener.on_edge
        )
        callback.cancel.assert_called_once_with()
        gpio.gpiochip_close.assert_called_once_with(42)

    def test_hardware_receiver_closes_chip_on_setup_failure(self):
        gpio = Mock()
        gpio.gpiochip_open.return_value = 42
        gpio.gpio_claim_alert.side_effect = RuntimeError("claim failed")
        listener = receiver.Receiver(Mock())
        with patch.object(receiver, "GPIO_MODE", "hardware"), \
                patch.object(receiver, "lgpio", gpio), \
                self.assertRaisesRegex(RuntimeError, "claim failed"):
            listener.start()
        gpio.gpiochip_close.assert_called_once_with(42)
        self.assertIsNone(listener.handle)

    def test_hardware_receiver_requires_lgpio(self):
        listener = receiver.Receiver(Mock())
        with patch.object(receiver, "GPIO_MODE", "hardware"), \
                patch.object(receiver, "lgpio", None), \
                self.assertRaisesRegex(RuntimeError, "GPIO_MODE=mock"):
            listener.start()
