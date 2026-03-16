#!/usr/bin/env bash

PORT=7600
HOST_IP="192.168.0.38"
URL="http://$HOST_IP:$PORT"

echo "Starting ADB..."
adb start-server

echo "Waiting for tablet..."
adb wait-for-device

echo "Starting Chrome on tablet..."

# Chrome pakke og main activity
PACKAGE="com.android.chrome"
ACTIVITY="com.google.android.apps.chrome.Main"

# FLAG_ACTIVITY_NEW_TASK=0x10000000, FLAG_ACTIVITY_CLEAR_TOP=0x04000000, FLAG_ACTIVITY_NO_ANIMATION=0x00010000
# Combined: 0x14010000
adb shell am start -n "$PACKAGE/$ACTIVITY" -f 0x14010000 -d "$URL"

echo ""
echo "Tablet should now display:"
echo "$URL"
