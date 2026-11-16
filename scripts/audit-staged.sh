#!/usr/bin/env bash
# Pre-commit secret audit.
#
# Run before every commit. It inspects what is STAGED (not the working tree)
# and refuses anything that looks like Lightning node authority, a key, a seed,
# or live payment material. Exits non-zero on a finding so a commit can be
# gated on it.
#
#   bash scripts/audit-staged.sh
set -uo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
findings=0

staged_files=$(git diff --cached --name-only --diff-filter=ACMR)
if [ -z "$staged_files" ]; then
  echo "${YELLOW}Nothing staged.${OFF}"
  exit 0
fi

echo "== Staged files"
echo "$staged_files" | sed 's/^/   /'
echo

# ---------------------------------------------------------------- filenames --
# Files that must never enter history, whatever their contents.
banned_names='(\.macaroon$|^tls\.(cert|key)$|/tls\.(cert|key)$|\.pem$|\.key$|wallet\.db$|channel\.(db|backup)$|\.seed$|\.mnemonic$|^\.env($|\.)|/\.env($|\.)|\.preimage$)'
while IFS= read -r f; do
  if printf '%s' "$f" | grep -Eq "$banned_names"; then
    echo "${RED}BLOCKED${OFF} filename: $f"
    findings=$((findings + 1))
  fi
done <<< "$staged_files"

# ----------------------------------------------------------------- contents --
# Added lines only: deletions cannot leak anything new.
added=$(git diff --cached -U0 --diff-filter=ACMR | grep -E '^\+' | grep -v '^+++' || true)

scan() { # pattern label
  local hits
  hits=$(printf '%s\n' "$added" | grep -nEi "$1" || true)
  if [ -n "$hits" ]; then
    echo "${RED}BLOCKED${OFF} $2"
    printf '%s\n' "$hits" | head -5 | cut -c1-120 | sed 's/^/     /'
    findings=$((findings + 1))
  fi
}

scan 'BEGIN [A-Z ]*PRIVATE KEY'                 'private key block'
scan '[0-9a-f]{64,}'                            '64+ hex chars (preimage, macaroon or key material)'
scan 'lnbc[0-9]+[munp]?1[0-9a-z]{20,}'          'real-looking BOLT11 invoice'
scan '(xprv|tprv)[0-9a-zA-Z]{50,}'              'extended private key'
scan '(api[_-]?key|secret[_-]?key|access[_-]?token)[\"'"'"' :=]+[A-Za-z0-9/_+-]{16,}' 'hardcoded credential'
scan '\b(abandon|zoo)\b([ ,]+[a-z]+){11,}'      'BIP39-looking seed phrase'

# A real recipient phone number should never be committed as fixture data.
scan '\+?234[0-9]{10}'                          'Nigerian phone number'

echo
if [ "$findings" -gt 0 ]; then
  echo "${RED}Audit FAILED with $findings finding(s). Nothing should be committed until these are resolved.${OFF}"
  exit 1
fi
echo "${GREEN}Audit passed: no node credentials, keys, seeds or live payment material staged.${OFF}"
exit 0
