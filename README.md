# Podcast Pi Player

A self-hosted podcast player for Raspberry Pi with:

- server-side RSS fetching
- episode downloads stored on the Pi
- installable PWA frontend
- per-episode playback resume in local storage
- optional offline caching of downloaded episodes onto the phone through the service worker
- Media Session integration for better mobile playback controls

## What “offline” means in this version

There are two download layers:

1. **Download to Pi**: saves the episode file onto the Raspberry Pi under `data/downloads/`
2. **Cache on phone**: after an episode exists on the Pi, the installed PWA can cache that `/media/...` file locally in the browser for offline playback on the phone

That means:

- on your home network, you can always stream downloaded files from the Pi
- away from the Pi, playback can still work **only for episodes you explicitly cached on the phone** in the PWA

## Raspberry Pi setup

### 1. Install system packages

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip
```

### 2. Copy the project onto the Pi

Place the folder anywhere convenient, for example:

```bash
/home/pi/podcast_pi_player
```

### 3. Create the virtual environment and install dependencies

```bash
cd /home/pi/podcast_pi_player
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Run the app

```bash
python app.py
```

It listens on:

```bash
0.0.0.0:5000
```

So it is reachable on your local network at something like:

```bash
http://192.168.1.50:5000
```

Find the Pi IP with:

```bash
hostname -I
```

## Install as a service on boot

Create:

```bash
sudo nano /etc/systemd/system/podcastpi.service
```

Paste:

```ini
[Unit]
Description=Podcast Pi Player
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/podcast_pi_player
Environment="PATH=/home/pi/podcast_pi_player/.venv/bin"
ExecStart=/home/pi/podcast_pi_player/.venv/bin/python /home/pi/podcast_pi_player/app.py
Restart=always

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable podcastpi.service
sudo systemctl start podcastpi.service
sudo systemctl status podcastpi.service
```

## Install on Android

1. Connect the phone to the same Wi‑Fi as the Pi
2. Open the Pi URL in Chrome
3. Use **Add to Home Screen** or the in-app install button
4. Download an episode to the Pi
5. Tap **Cache on phone** for the episodes you want available away from home

## Notes

- This is a strong starter, not a production podcast client yet
- Downloads are sequential and handled inside the Flask process
- Very large libraries would benefit from background job handling and a richer database schema
- For internet exposure, put it behind HTTPS and authentication before opening it outside your local network

## Password protection for internet exposure

This version includes built-in login protection using a Flask session cookie. Before exposing the app to the internet, set these environment variables on the Pi:

- `PODCASTPI_USERNAME`
- `PODCASTPI_PASSWORD_HASH`
- `PODCASTPI_SECRET_KEY`
- optionally `PODCASTPI_SECURE_COOKIE=1` when you are serving the app over HTTPS

### Generate a password hash

You can generate a hash directly on the Pi with Python:

```bash
python3 - <<'PY'
from werkzeug.security import generate_password_hash
print(generate_password_hash('replace-with-your-password'))
PY
```

Copy the printed hash into `PODCASTPI_PASSWORD_HASH`.

### Example systemd service with authentication

```ini
[Unit]
Description=Podcast Pi Player
After=network.target

[Service]
User=pi
WorkingDirectory=/home/pi/podcast_pi_player
Environment="PATH=/home/pi/podcast_pi_player/.venv/bin"
Environment="PODCASTPI_USERNAME=admin"
Environment="PODCASTPI_PASSWORD_HASH=PASTE_HASH_HERE"
Environment="PODCASTPI_SECRET_KEY=replace-with-a-long-random-secret"
# Set this to 1 only when the app is served behind HTTPS
Environment="PODCASTPI_SECURE_COOKIE=0"
ExecStart=/home/pi/podcast_pi_player/.venv/bin/python /home/pi/podcast_pi_player/app.py
Restart=always

[Install]
WantedBy=multi-user.target
```

### Recommended reverse proxy

For a public deployment, put the app behind Nginx or Caddy with HTTPS. The built-in password gate is a strong first layer, but you should still run it behind TLS so your password is never sent in clear text.
