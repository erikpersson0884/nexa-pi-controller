# Nexa Controller Pi

A small self-hosted web UI for controlling Nexa self-learning 433 MHz outlets from a Raspberry Pi 5, with countdowns and weekly schedules.

[![Last Commit][last-commit-shield]][last-commit-url]
[![Repo Size][repo-size-shield]][repo-size-url]
[![Author][author-shield]][author-url]

# Index

1. [About the project](#about-the-project)
1. [Features](#features)
1. [Built with](#built-with)
1. [Getting started](#getting-started)
1. [Configuration](#configuration)
1. [Scripts](#scripts)
1. [Deployment](#deployment)
1. [Troubleshooting](#troubleshooting)
1. [Contributing](#contributing)
1. [License](#license)
1. [Authors](#authors)
1. [Acknowledgments](#acknowledgments)

# About the project

Nexa Controller Pi lets you switch Nexa self-learning outlets from your phone or laptop without the original remote. A cheap 433 MHz transmitter module is wired to a Raspberry Pi 5, and a Python/Flask app generates the Nexa signal directly on a GPIO pin and serves a simple web page on your local network.

433 MHz is one-way, so the page shows the **last command sent**, not the outlet's real state. If someone uses a physical remote, the page won't know.

This repository contains **only the controller app**. It requires a 433 MHz ASK/OOK transmitter module (FS1000A type) wired to the Pi, and outlets that support Nexa's self-learning protocol.

## Built with

![Python][tech-1-shield]
![Flask][tech-2-shield]
![Docker][tech-3-shield]
![Raspberry Pi][tech-4-shield]

## Features

- Switch outlets on and off from any device on your network
- Pair new outlets from the web page ("Add outlet")
- "All off" button
- Countdown timers ("turn off in 30 minutes")
- Weekly schedules (time + days), which can be disabled or deleted
- Timers, outlets and last-known states are saved to disk and survive restarts
- Runs directly with Python or as a Docker container

# Getting started

## Prerequisites

- Raspberry Pi 5 running Raspberry Pi OS (Bookworm or newer)
- A 433 MHz transmitter module (the 3-pin board, not the receiver)
- About 17 cm of solid wire for the antenna, soldered to the module's ANT pad
- Nexa self-learning outlets
- Python 3 with Flask, lgpio and python-dotenv, or Docker

## Wiring

Power off the Pi before connecting anything.

| Transmitter pin | Pi 5 physical pin | Description |
|---|---|---|
| VCC | Pin 2 | 5 V |
| GND | Pin 6 | Ground |
| DATA | Pin 11 | GPIO17 |

Check the labels printed on your module, because the pin order can vary between batches.

## Installation

```sh
# Clone the repository
git clone https://github.com/erikpersson0884/smart-socket-controller.git

# Navigate into the project directory
cd smart-socket-controller

# Install dependencies
sudo apt update
sudo apt install python3-flask python3-lgpio python3-dotenv

# Find the GPIO chip number of the Pi's header (look for pinctrl-rp1)
gpiodetect

# Start the app
python3 webui.py
```

The app runs on `http://<pi-ip>:8080` (or `http://raspberrypi.local:8080`). Edit `CHIP` at the top of `webui.py` if `gpiodetect` shows a different number than 15.

## Pairing outlets

1. Open the web page and press **Add outlet**.
2. Give the outlet a name and confirm.
3. Put the outlet in learning mode (plug it in, or hold its button until the LED blinks) before confirming.
4. The app sends an "on" command with the next free unit number (0-15), and the outlet remembers it.

Pair one outlet at a time. Up to 16 outlets are supported per transmitter ID.

# Configuration

Using a `.env` file is optional. Copy `.env.example` to `.env` to change the defaults.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the web UI listens on |
| `DATA_DIR` | home folder (`/data` in Docker) | Where `nexa_state.json`, `nexa_devices.json` and `nexa_timers.json` are stored |
| `TZ` | system time zone | Time zone used by schedules (set it in Docker) |

Hardware settings are constants at the top of `webui.py`:

| Constant | Default | Description |
|---|---|---|
| `CHIP` | `15` | GPIO chip of the Pi's header (`pinctrl-rp1` in `gpiodetect`) |
| `PIN` | `17` | BCM GPIO number the transmitter DATA pin is wired to |
| `TX_ID` | `12345678` | Transmitter ID (0-67108863) your outlets learn. Changing it means re-pairing every outlet |
| `REPEAT` | `6` | How many times each command is sent |

# Scripts

| Command | What it does |
|---|---|
| `python3 webui.py` | Start the web UI |
| `docker compose up --build` | Build and start the container |
| `docker compose logs -f` | Follow the container logs |
| `docker compose down` | Stop the container |

# Deployment

The repository includes a `Dockerfile` and a `docker-compose.yml`.

```sh
docker compose up --build
```

The app is then available on `http://<pi-ip>:8080` (host port 8080 maps to port 8080 in the container).

**Requirements at runtime:** the container must run on the same Pi the transmitter is wired to, and `/dev/gpiochip15` must exist on the host.

## How it is configured

- **GPIO access:** the container gets only the GPIO chip device (`/dev/gpiochip15`) instead of full privileged mode. Update the `devices:` line if `gpiodetect` shows a different number.
- **Persistence:** `DATA_DIR=/data` is mounted from `./data`, so outlets, timers and states survive rebuilds.
- **Time zone:** schedules use the container's clock, so set `TZ` in `docker-compose.yml`.
- **Portainer:** build the image on the Pi (`docker build -t nexa-web:latest .`) and use the compose file as a stack, or deploy the stack from the Git repository.

# Troubleshooting

| Problem | What to try |
|---|---|
| `GPIO error` on start | Run `gpiodetect` and set `CHIP` to the number next to `pinctrl-rp1`. In Docker, update the `devices:` mapping too |
| Permission error | Run with `sudo`, or `sudo usermod -aG gpio $USER` and log in again |
| Outlet does nothing | Test within a metre, check the antenna is straight and soldered, and try another transmitter module |
| On and off are swapped | Swap `"1"` and `"0"` in the `bits` line in `transmit()` |
| Outlet stopped responding | It may have forgotten its pairing. Put it in learning mode and send "on" again |
| Schedules fire at the wrong time | Check the clock with `date` and set the time zone (`timedatectl`, or `TZ` in Docker) |

**Security:** the page has no login. Keep it on your home network and do not forward the port on your router.

# Contributing

If you want to contribute, follow these steps:

1. Fork the repository
2. Create a new branch (`git checkout -b feature-branch`)
3. Make your changes and test them against a real outlet
4. Commit your changes (`git commit -m 'Add new feature'`)
5. Push to the branch (`git push origin feature-branch`)
6. Create a Pull Request

# Authors

<p align="center">
  <img src="https://github.com/erikpersson0884.png?size=100" alt="Erik Persson" width="100" height="100" />
  <br />
  <strong><a href="https://github.com/erikpersson0884">Erik Persson</a></strong><br />
  Creator &amp; Maintainer
</p>




<!-- Repo info shields -->
[last-commit-shield]: https://img.shields.io/github/last-commit/erikpersson0884/smart-socket-controller/main?style=for-the-badge&cacheSeconds=30
[last-commit-url]: https://github.com/erikpersson0884/smart-socket-controller/commits/main

[repo-size-shield]: https://img.shields.io/github/repo-size/erikpersson0884/smart-socket-controller?style=for-the-badge&cacheSeconds=60
[repo-size-url]: https://github.com/erikpersson0884/smart-socket-controller

[author-shield]: https://img.shields.io/badge/Author-Erik-blue?style=for-the-badge
[author-url]: {{AUTHOR_URL}}

<!-- Tech stack shields -->
[tech-1-shield]: https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white&style=for-the-badge
[tech-2-shield]: https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white&style=for-the-badge
[tech-3-shield]: https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white&style=for-the-badge
[tech-4-shield]: https://img.shields.io/badge/Raspberry%20Pi-A22846?logo=raspberrypi&logoColor=white&style=for-the-badge