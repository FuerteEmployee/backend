#!/bin/sh
# Wait for a device to fetch 1.2.3 and then report "Up to date" (24 bytes) on a
# later check -- that pair is the proof the bundle actually booted, which 1.2.2
# never managed.
END=$(( $(date +%s) + 480 ))
while [ "$(date +%s)" -lt "$END" ]; do
  echo "=== $(date -u +%H:%M:%S) ==="
  ssh -F /dev/null -i ~/beontime-key.pem ubuntu@13.202.48.15 \
    "sudo tail -n 150 /var/log/nginx/access.log | grep -E 'app/update|bundle-1\.2\.3' | grep -v curl | tail -5"
  sleep 45
done
