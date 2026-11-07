# MIDIBRAIN on a Raspberry Pi

Tested approach: Ubuntu (or Raspberry Pi OS) on a Pi 4 or 5, with your MIDI devices on USB.

```bash
sudo apt update && sudo apt install -y python3 python3-venv python3-dev build-essential libasound2-dev libjack-jackd2-dev git
git clone https://github.com/clewis10/midibrain.git ~/midibrain
cd ~/midibrain
python3 -m venv .venv
.venv/bin/pip install -e .
```

Plug in your devices, then list the MIDI ports the Pi can see:

```bash
.venv/bin/midibrain-mixer ports
```

Start it by hand first:

```bash
cp config/performance.example.json config/performance.local.json
.venv/bin/midibrain-mixer run --config config/performance.local.json --allow-unverified --web --host 0.0.0.0 --port 8788
```

Open `http://<pi-address>:8788/` from a laptop on the same network, build your rig on the Patch canvas, and press **Apply to rig**. Everything keeps running with the browser closed.

## Start on boot

Edit `scripts/midibrain.service` if your user or folder is not `pi` / `~/midibrain`, then:

```bash
sudo bash scripts/install_service.sh
journalctl -u midibrain -f      # logs
```

`--host 0.0.0.0` makes the web page reachable on your network with no login. Use it only on a network you trust, or leave it off and use an SSH tunnel: `ssh -N -L 8788:127.0.0.1:8788 user@pi`.
