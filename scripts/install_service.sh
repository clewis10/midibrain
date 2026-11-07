#!/usr/bin/env bash
# Installs and starts scripts/midibrain.service. Run from the repository root: sudo bash scripts/install_service.sh
set -euo pipefail
[[ "${EUID}" -eq 0 ]] || { echo "Run as root: sudo bash scripts/install_service.sh"; exit 1; }
cp "$(pwd)/scripts/midibrain.service" /etc/systemd/system/midibrain.service
systemctl daemon-reload
systemctl enable midibrain.service
systemctl restart midibrain.service
systemctl status midibrain.service --no-pager
