# FIFA Pool Shared Setup

This version uses `fifa-pool-data.txt` as the shared file.

## Run
1. Put these files in the same folder:
   - fifa-pool-shared.html
   - server.js
   - fifa-pool-data.txt
2. Install Node.js if needed.
3. In this folder, run:
   node server.js
4. Open:
   http://localhost:3000
5. For other users on the same network, use:
   http://YOUR-COMPUTER-IP:3000

Important: Do not open the HTML by double-clicking it. Browsers cannot write to a shared text file directly. Use the server URL.
