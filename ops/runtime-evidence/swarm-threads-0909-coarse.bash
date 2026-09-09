# Reproduce whole-second filesystem timestamp comparison, without changing gates.
function [ {
  if builtin [ "$#" -eq 4 ] && builtin [ "$2" = '-nt' ]; then
    builtin [ "$(stat -f %m "$1")" -gt "$(stat -f %m "$3")" ]
  else
    builtin [ "$@"
  fi
}
