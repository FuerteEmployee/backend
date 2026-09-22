#!/bin/sh
# Watch for the production bundle actually landing on a real phone.
#
# Three signals, in the order they should appear:
#   1. POST /api/app/update answered with ~180 bytes (an OFFER) rather than
#      35 ("No release configured") or 24 ("Up to date").
#   2. GET /bundles/bundle-1.2.2.zip -- the device downloading it.
#   3. source='background' Tracking rows, which is the thing all of this is for.
END=$(( $(date +%s) + 540 ))
while [ "$(date +%s)" -lt "$END" ]; do
  echo "=== $(date -u +%H:%M:%S) ==="
  ssh -F /dev/null -i ~/beontime-key.pem ubuntu@13.202.48.15 \
    "sudo tail -n 400 /var/log/nginx/access.log | grep -E 'app/update|bundle-1\.2\.2' | grep -v curl | tail -6"
  sleep 45
done
