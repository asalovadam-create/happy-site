#!/bin/bash
# Обновление сайта на сервере: bash /opt/happytoys/deploy/update.sh
set -e
cd /opt/happytoys
git pull
./venv/bin/pip install -q -r requirements.txt
systemctl restart happytoys
sleep 3
curl -s localhost:8000/api/health; echo
