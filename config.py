"""Application configuration and hardware/data paths."""

import os

from dotenv import load_dotenv

load_dotenv()

CHIP = 15
PIN = 17
TX_ID = 12345678
T = 260e-6
REPEAT = 6
PORT = int(os.getenv("PORT", 8080))
HOST = os.getenv("HOST", "127.0.0.1")

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv("DATA_DIR", os.path.join(PROJECT_DIR, "data"))
STATE_FILE = os.path.join(DATA_DIR, "nexa_state.json")
DEVICES_FILE = os.path.join(DATA_DIR, "nexa_devices.json")
TIMER_FILE = os.path.join(DATA_DIR, "nexa_timers.json")
