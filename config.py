"""Application configuration and hardware/data paths."""

import os
import base64

from dotenv import load_dotenv

load_dotenv()

CHIP = 15
PIN = 17
TX_ID = 12345678
T = 260e-6
REPEAT = 6
GPIO_MODE = os.getenv("GPIO_MODE", "hardware").lower()
RX_PIN = int(os.getenv("RX_PIN", 27))
SECRET_KEY = os.getenv("SECRET_KEY")
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "admin")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD")
AUTH_PASSWORD_HASH = os.getenv("AUTH_PASSWORD_HASH")
AUTH_PASSWORD_HASH_FILE = os.getenv("AUTH_PASSWORD_HASH_FILE")
AUTH_PASSWORD_HASH_B64 = os.getenv("AUTH_PASSWORD_HASH_B64")
if AUTH_PASSWORD:
    AUTH_PASSWORD_HASH = None
    AUTH_PASSWORD_HASH_FILE = None
    AUTH_PASSWORD_HASH_B64 = None
elif AUTH_PASSWORD_HASH_FILE:
    try:
        with open(AUTH_PASSWORD_HASH_FILE, encoding="utf-8") as password_hash_file:
            AUTH_PASSWORD_HASH = password_hash_file.read().strip()
    except OSError as exc:
        raise RuntimeError(
            f"Unable to read AUTH_PASSWORD_HASH_FILE: {AUTH_PASSWORD_HASH_FILE}"
        ) from exc
if AUTH_PASSWORD_HASH_B64:
    try:
        AUTH_PASSWORD_HASH = base64.b64decode(
            AUTH_PASSWORD_HASH_B64, validate=True
        ).decode("ascii")
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError("AUTH_PASSWORD_HASH_B64 must be valid Base64 text")
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
PORT = int(os.getenv("PORT", 8080))
HOST = os.getenv("HOST", "127.0.0.1")

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv("DATA_DIR", os.path.join(PROJECT_DIR, "data"))
STATE_FILE = os.path.join(DATA_DIR, "nexa_state.json")
DEVICES_FILE = os.path.join(DATA_DIR, "nexa_devices.json")
TIMER_FILE = os.path.join(DATA_DIR, "nexa_timers.json")
