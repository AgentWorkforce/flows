# Reproduce whole-second filesystem timestamp comparison, without changing gates.
# macOS only: BSD stat's -f %m returns whole-second mtime (GNU stat differs).
# Only plain and negated -nt are replaced. All other expressions delegate to
# Bash unchanged; "$@" INCLUDES the caller's closing ] argument. Adding another
# ] to the builtin invocation would be an error, not a syntax repair.
if [[ $(uname -s) != Darwin ]]; then
  printf '%s\n' 'COARSE_FIXTURE_REQUIRES_MACOS: use the native suite on other hosts' >&2
  exit 2
fi
function [ {
  if builtin [ "$#" -eq 4 ] && builtin [ "$2" = '-nt' ]; then
    builtin [ "$(stat -f %m "$1")" -gt "$(stat -f %m "$3")" ]
  elif builtin [ "$#" -eq 5 ] && builtin [ "$1" = '!' ] && builtin [ "$3" = '-nt' ]; then
    builtin [ ! "$(stat -f %m "$2")" -gt "$(stat -f %m "$4")" ]
  else
    builtin [ "$@"
  fi
}
