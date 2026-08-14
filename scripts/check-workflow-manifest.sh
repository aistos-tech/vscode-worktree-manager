#!/bin/bash
# Validates .claude/aistos-workflow.json — the file the shared aistos-dev workflow skills read to
# learn this repository's base branch, gate commands, security paths and tooling.
#
# WHY THIS EXISTS SEPARATELY FROM THE PLUGIN'S OWN VALIDATOR. `aistos-workflow-config --validate` is
# authoritative and runs at the moment a skill acts. It cannot run here: it ships inside a PRIVATE
# plugin repository, so CI would need a deploy key to reach it, and a gate that needs a credential is
# a gate that gets disabled. This is a deliberate SUBSET, self-contained in jq, catching the class that
# matters at commit time — a manifest that is absent, malformed, or missing a required key.
#
# What only the resolver can check, and therefore what this does NOT: whether the installed plugin
# satisfies `minPluginVersion`, and whether a `steps.*.context` file exists on disk.
#
# Keep the required set in step with the plugin's schema
# (plugins/aistos-dev/schemas/aistos-workflow.schema.json). A key added there and not here is a
# manifest that passes CI and refuses at run time.

set -uo pipefail

MANIFEST=".claude/aistos-workflow.json"
rc=0
fail() { printf '::error file=%s::%s\n' "$MANIFEST" "$1"; printf '❌ %s\n' "$1"; rc=1; }

command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 1; }

[ -f "$MANIFEST" ] || { fail "missing: this repository opts into the shared workflow skills, which read it"; exit 1; }
jq -e . "$MANIFEST" >/dev/null 2>&1 || { fail "not valid JSON"; exit 1; }

q() { jq -r "$1" "$MANIFEST" 2>/dev/null; }

[ "$(q '.version')" = "1" ] || fail "\`version\` must be 1"
[ -n "$(q '.baseBranch // empty')" ] || fail "\`baseBranch\` is missing"

# Every gate set must be a non-empty array of non-empty strings, or a skill runs an empty gate list and
# reports success.
sets=$(q '.gates | if type == "object" then (keys | join(" ")) else empty end')
if [ -z "$sets" ]; then
  fail "\`gates\` must be an object of named command lists"
else
  for s in $sets; do
    n=$(jq -r --arg s "$s" '.gates[$s] | if type == "array" then length else -1 end' "$MANIFEST")
    [ "$n" -gt 0 ] 2>/dev/null || fail "\`gates.$s\` must be a non-empty array of commands"
  done
fi

# Three-state on purpose: a regex, or the literal "none" as a reviewable declaration. Unset is refused,
# because a security gate that matches nothing looks exactly like a configured one.
if [ "$(q '.securityPaths | type')" != "object" ]; then
  fail "\`securityPaths\` must be an object with \`include\` and optional \`exclude\`"
elif [ -z "$(q '.securityPaths.include // empty')" ]; then
  fail "\`securityPaths.include\` is unset — give a regex, or the literal \"none\" to declare there are no high-risk paths"
fi

case "$(q '.worktrees // empty')" in
  script|none) ;;
  *) fail "\`worktrees\` must be \"script\" or \"none\"" ;;
esac

if [ "$(q '.tooling | type')" != "object" ]; then
  fail "\`tooling\` must declare ghBot, prStack and tally"
else
  for tool in ghBot prStack tally; do
    # `// empty` is unusable here: in jq, `false // empty` yields empty, so a tool declared false would
    # read as missing. tostring keeps false and null distinguishable.
    case "$(q ".tooling.$tool | tostring")" in
      true|false) ;;
      *) fail "\`tooling.$tool\` must be true or false" ;;
    esac
  done
fi

# Every gate command that names a package script must resolve to one. This is the check that catches the
# most likely real drift: a script renamed in package.json while the manifest keeps naming the old one.
if [ -f package.json ]; then
  while read -r cmd; do
    case "$cmd" in
      "bun run "*)
        script="${cmd#bun run }"
        jq -e --arg s "$script" '.scripts | has($s)' package.json >/dev/null 2>&1 \
          || fail "gate \`$cmd\` names a package script that does not exist"
        ;;
    esac
  done < <(jq -r '.gates | to_entries[] | .value[]' "$MANIFEST" 2>/dev/null | sort -u)
fi

[ "$rc" -eq 0 ] && printf '✅ %s is usable by the shared workflow skills\n' "$MANIFEST"
exit $rc
