import unittest
from unittest.mock import patch

import receiver


class ReceiverTestCase(unittest.TestCase):
    def test_decode_frame(self):
        bits = format(12345678, "026b") + "01" + format(4, "04b")

        self.assertEqual(
            receiver.decode_frame(bits),
            (12345678, False, True, 4),
        )

    def test_repeated_frame_is_required_and_debounced(self):
        commands = []
        listener = receiver.Receiver(lambda *command: commands.append(command))
        bits = format(12345678, "026b") + "01" + format(4, "04b")

        with patch.object(receiver.time, "monotonic", side_effect=[1.0, 1.1, 1.2]):
            listener.handle_frame(bits)
            listener.handle_frame(bits)
            listener.handle_frame(bits)

        self.assertEqual(commands, [(12345678, False, True, 4)])

    def test_mock_mode_does_not_open_gpio(self):
        listener = receiver.Receiver(lambda *_command: None)
        with patch.object(receiver, "GPIO_MODE", "mock"):
            self.assertFalse(listener.start())
