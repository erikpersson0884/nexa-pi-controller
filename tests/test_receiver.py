import unittest
import threading
import time
from unittest.mock import patch

import receiver


class ReceiverTestCase(unittest.TestCase):
    def test_decode_frame(self):
        bits = format(12345679, "026b") + "01" + format(4, "04b")

        self.assertEqual(
            receiver.decode_frame(bits),
            (12345678, False, True, 4),
        )

    def test_repeated_frame_is_required_and_debounced(self):
        commands = []
        received = threading.Event()

        def on_command(*command):
            commands.append(command)
            received.set()

        listener = receiver.Receiver(on_command)
        bits = format(12345678, "026b") + "01" + format(4, "04b")

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
        with patch.object(receiver, "GPIO_MODE", "mock"):
            self.assertFalse(listener.start())
