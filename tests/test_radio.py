import unittest
from unittest.mock import patch

import radio


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
