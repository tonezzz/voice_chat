#!/usr/bin/env bash
set -euo pipefail

SSH_TARGET=${SSH_TARGET:-root@chaba.surf-thailand.com}
SSH_KEY=${SSH_KEY:-/workspace/localdata/keys/host1_ed25519}
SSH_CMD=(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${SSH_TARGET}")

echo "[host1-ssh] Ensuring chaba user and authorized_keys..."
"${SSH_CMD[@]}" <<'EOSSH'
set -euo pipefail
if ! getent group sshusers >/dev/null; then
  groupadd sshusers
fi
if ! id chaba >/dev/null 2>&1; then
  adduser --disabled-password --gecos '' chaba
fi
usermod -aG sudo,docker,sshusers chaba
install -d -m 700 -o chaba -g chaba /home/chaba/.ssh
cat >/home/chaba/.ssh/authorized_keys <<'KEY'
ssh-ed25519 AAAAC3NzaC1lZD1NTE5AAAAAIH7RaOtAolJk6Os7dV2RK78grkxE10j1v9392rf66rAHAD0HVC3QLkNWvbnRyb2w= host1-control
KEY
chown chaba:chaba /home/chaba/.ssh/authorized_keys
chmod 600 /home/chaba/.ssh/authorized_keys
passwd -l chaba || true
EOSSH

echo "[host1-ssh] Updating sshd_config..."
"${SSH_CMD[@]}" <<'EOSSH'
set -euo pipefail
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%F-%H%M%S)
cat >/etc/ssh/sshd_config <<'CONF'
Include /etc/ssh/sshd_config.d/*.conf

Port 22
AddressFamily any
ListenAddress 0.0.0.0
ListenAddress ::

PermitRootLogin no
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
AuthenticationMethods publickey
AllowUsers chaba
AllowGroups sshusers

X11Forwarding no
PrintMotd no
ClientAliveInterval 300
ClientAliveCountMax 2
TCPKeepAlive no
AllowAgentForwarding no
AllowTcpForwarding no
Banner none
CONF
chmod 600 /etc/ssh/sshd_config
systemctl restart ssh
EOSSH

echo "[host1-ssh] Completed. Test with: ssh -i ${SSH_KEY} chaba@${SSH_TARGET#*@}"
