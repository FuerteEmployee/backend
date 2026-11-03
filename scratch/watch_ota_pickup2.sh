#!/bin/sh
# Poll nginx access log for real /api/app/update hits (excluding our own curl
# tests) and Mongo for new source=background Tracking rows, every 30s for up
# to 9 minutes. The first real hit at 12:27:51 got "No release configured"
# (35 bytes) -- likely because custom_id had not yet been (re)persisted on
# that device's very first check after login. Watching for the NEXT hit from
# the same device, which should carry the tagged adminId and get offered 1.2.1.
END=$(( $(date +%s) + 540 ))
while [ "$(date +%s)" -lt "$END" ]; do
  echo "=== $(date -u +%H:%M:%S) ==="
  ssh -F /dev/null -i ~/beontime-key.pem ubuntu@13.202.48.15 \
    "sudo tail -n 200 /var/log/nginx/access.log | grep 'app/update' | grep -v 'test-dev\|curl'"
  sleep 30
done
