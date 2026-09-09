# Reproduce whole-second filesystem timestamp comparison, without changing gates.
function [ {
  if builtin [ "$#" -eq 4 ] && builtin [ "$2" = '-nt' ]; then
    builtin [ "$(stat -f %m "$1")" -gt "$(stat -f %m "$3")" ]
  elif builtin [ "$#" -eq 5 ] && builtin [ "$1" = '!' ] && builtin [ "$3" = '-nt' ]; then
    builtin [ ! "$(stat -f %m "$2")" -gt "$(stat -f %m "$4")" ]
  else
    builtin [ "$@"
  fi
}
