#!/bin/bash

# Start npm in the background
npm run standalone &

# Wait for the server to be ready
echo "Waiting for localhost:7600..."
while ! curl -s http://localhost:7600 > /dev/null 2>&1; do
  sleep 1
done
echo "Server is up!"

# Find Chrome and open in app mode (no URL bar, minimal UI)
if command -v google-chrome &> /dev/null; then
  google-chrome --app=http://localhost:7600
elif command -v chromium &> /dev/null; then
  chromium --app=http://localhost:7600
elif [ -f "C:/Program Files/Google/Chrome/Application/chrome.exe" ]; then
  start "" "C:/Program Files/Google/Chrome/Application/chrome.exe" --app=http://localhost:7600
elif [ -f "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" ]; then
  start "" "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe" --app=http://localhost:7600
elif command -v open &> /dev/null; then
  open -a "Google Chrome" --args --app=http://localhost:7600
else
  echo "Chrome not found. Please open http://localhost:7600 manually."
fi

# Keep the script running so npm stays alive
wait