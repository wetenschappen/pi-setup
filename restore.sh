#!/usr/bin/env bash
set -euo pipefail

# ─── Pi Setup Restore Script ─────────────────────────────────────────────
# Run from ~/pi-setup after a fresh pi install or nuked config.
#
#   cd ~/pi-setup && bash restore.sh
#
# Does NOT overwrite secrets (auth.json) — you re-auth manually after.
# Does NOT reinstall the PDF venv — run the pip command separately.
# ──────────────────────────────────────────────────────────────────────────

echo "Restoring pi configuration..."

# 1. Core config
cp pi/agent/models.json   ~/.pi/agent/models.json
cp pi/agent/settings.json ~/.pi/agent/settings.json

# 2. Extensions
cp pi/agent/extensions/pi-custom.ts     ~/.pi/agent/extensions/pi-custom.ts
cp pi/agent/extensions/proxy-command.ts ~/.pi/agent/extensions/proxy-command.ts
cp -r pi/agent/extensions/pdf-tools     ~/.pi/agent/extensions/pdf-tools/

# 3. Skills
cp -r pi/agent/skills/pi-pdf ~/.pi/agent/skills/pi-pdf/

# 4. Theme
cp pi/agent/themes/high-contrast-dark.json ~/.pi/agent/themes/high-contrast-dark.json

# 5. Zed proxy
cp zed-proxy/zed-proxy.js ~/.zed-proxy/zed-proxy.js

# 6. Token interceptor + launcher
cp local-bin/zed-token ~/.local/bin/zed-token
cp local-bin/pi-zed    ~/.local/bin/pi-zed 2>/dev/null || true
chmod +x ~/.local/bin/zed-token

# 7. Cron job (crontab won't survive a restore — remind user)
echo ""
echo "─────────────────────────────────────────────────"
echo "  ✅ Config restored"
echo ""
echo "  Next steps:"
echo "  1. Reinstall PDF venv if needed:"
echo "     python3 -m venv ~/.pi-pdf-venv"
echo "     ~/.pi-pdf-venv/bin/pip install pymupdf4llm pymupdf"
echo ""
echo "  2. Re-authenticate providers:"
echo "     /login opencode   (or paste your key)"
echo ""
echo "  3. Re-add cron job for Zed token:"
echo '     (sudo crontab -e) */30 * * * * /home/albertshalaj/.local/bin/zed-token > /dev/null 2>&1'
echo ""
echo "  4. Symlink zed-token:"
echo "     sudo ln -sf ~/.local/bin/zed-token /usr/local/bin/zed-token"
echo "─────────────────────────────────────────────────"
